import { fail } from "../core/http";
import {
  FORM_CORRECTION_NO_CHANGE_REASON,
  FORM_CORRECTION_PENDING_CONCILIATION_REASON,
  FORM_CORRECTION_STALE_REASON,
  PASSAGE_CHANGED_REASON,
  WORDING_OUTSIDE_REASON,
} from "~~/shared/constants/errorReasons";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  documentFormCorrections,
  documents,
  documentVersions,
  passageWordings,
} from "../../db/schema";
import {
  consolidateApproved,
  passageKey,
} from "~~/shared/utils/content/passages";
import {
  pendingPassagesOf,
  storedPendingPassages,
  type ConciliationPassage,
  type PendingPassage,
} from "~~/shared/utils/content/pendingPassages";
import { approvedRows, loadPassageWordings, wordingInputs } from "./wordings";
import { assertOptimisticLock, STALE_WRITE_DATA } from "../optimisticLock";
import {
  canCorrectForm,
  canManageDocuments,
  canModerate,
  type Actor,
} from "./actor";
import { recordEvent } from "./events";
import {
  formCorrectionMode,
  hasApprovedText,
  hashBlocks,
  isProponentSide,
  lockDocument,
  nextVersionNumber,
  type DocumentRouteContext,
  type PresentedDocumentRow,
} from "./documents";
import type {
  ConciliationBody,
  FormCorrectionAuthor,
  FormCorrectionBody,
  FormCorrectionDecisionBody,
  FormCorrectionDto,
  FormCorrectionsDto,
  FormCorrectionWithdrawBody,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import type { SigningFiles } from "./agreementsSignedFile";
import { removeAllSigningFiles, voidSigning } from "./agreementsSignedFile";

/**
 * Corrections of form to an approved text (user's decisions of
 * 2026-11-21). Once the final vote approves a structured document, its
 * consolidated version may be corrected in form, freely, with no deadline
 * and with the assembly closed too:
 * - the Secretaría (document:manage) and the Mesa (session:moderate) edit
 *   it directly: a new consolidated version replaces the one in force at
 *   once (`replacesVersionId`), with the reason as its note and no annex;
 * - its presenters propose one, which waits for the Secretaría to apply
 *   or reject it (with a note), or for its author to withdraw it.
 * Every correction is the whole corrected text over the version it was
 * made on; one made on a version that is no longer in force is refused
 * (409 `stale_write`), and so is applying a proposal another correction
 * overtook (409 `form_correction_stale`). Annulling the final vote voids the proposals still waiting
 * (voidPendingFormCorrections).
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type CorrectionRow = typeof documentFormCorrections.$inferSelect;

const STALE_MESSAGE =
  "El texto aprobado ha cambiado desde que lo abriste. Recarga la página";

/** A correction of form while a passage is pending conciliation. */
const PENDING_MESSAGE =
  "Primero hay que conciliar las enmiendas pendientes del texto aprobado";

/**
 * The data of that refusal. `pendingConciliation` is the flag before ARQ-1,
 * for an open tab of the previous client: drop it in the release after.
 */
const PENDING_CONCILIATION_DATA = {
  reason: FORM_CORRECTION_PENDING_CONCILIATION_REASON,
  pendingConciliation: true,
} as const;

/** Reads the corrections that are not applied (and their texts). */
function seesUnapplied(actor: Actor, document: PresentedDocumentRow): boolean {
  return (
    canManageDocuments(actor) ||
    canCorrectForm(actor) ||
    isProponentSide(actor, document)
  );
}

function madeAsOf(actor: Actor): FormCorrectionAuthor {
  if (canManageDocuments(actor)) return "secretaria";
  if (canModerate(actor)) return "mesa";
  if (canCorrectForm(actor)) return "authorized";
  return "presenter";
}

async function versionBlocks(
  executor: Executor,
  ids: string[],
): Promise<Map<string, Block[]>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ id: documentVersions.id, blocks: documentVersions.blocks })
    .from(documentVersions)
    .where(inArray(documentVersions.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row.blocks]));
}

/**
 * The consolidated version the final vote approved: the one in force,
 * followed back through the versions it replaced.
 */
async function votedVersionId(
  executor: Executor,
  current: string | null,
): Promise<string | null> {
  let id = current;
  for (let guard = 0; id && guard < 1_000; guard++) {
    const [row] = await executor
      .select({ replaces: documentVersions.replacesVersionId })
      .from(documentVersions)
      .where(eq(documentVersions.id, id));
    if (!row?.replaces) return id;
    id = row.replaces;
  }
  return id;
}

/** The corrections of a document as the actor reads them, oldest first. */
export async function listFormCorrections(
  ctx: DocumentRouteContext,
  executor: Executor = db,
): Promise<FormCorrectionsDto> {
  const { actor } = ctx;
  const [document] = await executor
    .select({
      consolidatedVersionId: documents.consolidatedVersionId,
    })
    .from(documents)
    .where(eq(documents.id, ctx.document.id));
  const current = document?.consolidatedVersionId ?? null;
  // A proposed conciliation applies while its passage is still pending,
  // whatever other passages were conciliated since.
  const stillPending = new Set(
    (await pendingOf(executor, current)).map((passage) => passage.key),
  );
  const all = await executor
    .select()
    .from(documentFormCorrections)
    .where(eq(documentFormCorrections.documentId, ctx.document.id))
    .orderBy(asc(documentFormCorrections.createdAt));
  const rows = seesUnapplied(actor, ctx.document)
    ? all
    : all.filter((row) => row.status === "applied");
  const befores = await versionBlocks(
    executor,
    rows.map((row) => row.fromVersionId),
  );
  const manages = canManageDocuments(actor);
  const corrections = rows.map((row): FormCorrectionDto => {
    const pending = row.status === "pending";
    const onCurrentText = row.passage
      ? stillPending.has(row.passage.key)
      : row.fromVersionId === current;
    return {
      id: row.id,
      status: row.status,
      madeAs: (row.madeAs as FormCorrectionAuthor) ?? "presenter",
      reason: row.reason,
      fromVersionId: row.fromVersionId,
      before: befores.get(row.fromVersionId) ?? [],
      blocks: row.blocks,
      onCurrentText,
      decisionNote: row.decisionNote,
      passage: row.passage
        ? {
            key: row.passage.key,
            amendmentIds: row.passage.amendmentIds,
            blockIds: row.passage.blockIds,
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
      can: {
        apply: pending && manages && onCurrentText,
        reject: pending && manages,
        withdraw:
          pending &&
          row.proposedByUserId !== null &&
          row.proposedByUserId === actor.user.id,
      },
    };
  });
  return {
    corrections,
    votedVersionId: await votedVersionId(executor, current),
  };
}

/**
 * Puts a corrected text in force: a new consolidated version that replaces
 * the current one, which the document points to from now on.
 */
async function applyText(
  tx: Executor,
  document: PresentedDocumentRow,
  input: {
    blocks: Block[];
    contentHash: string;
    reason: string;
    /** After a conciliation, the passages still pending (none: final). */
    pendingPassages?: PendingPassage[];
  },
  actor: Actor,
  /** Collects the signed PDFs it voids, removed once the caller commits. */
  cleanup: SigningFiles[],
): Promise<string> {
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: document.id,
      number: await nextVersionNumber(tx, document.id),
      kind: "consolidated",
      blocks: input.blocks,
      contentHash: input.contentHash,
      note: input.reason || null,
      pendingPassages:
        input.pendingPassages && input.pendingPassages.length > 0
          ? input.pendingPassages
          : null,
      replacesVersionId: document.consolidatedVersionId,
      createdByUserId: actor.user.id,
    })
    .returning({ id: documentVersions.id });
  await tx
    .update(documents)
    .set({ consolidatedVersionId: version!.id })
    .where(eq(documents.id, document.id));
  // A signed acta no longer signs this text: it is signed again.
  const voided = await voidSigning(
    tx,
    { assemblyId: document.assemblyId, documentId: document.id },
    actor,
    "form_correction",
  );
  if (voided) cleanup.push(voided);
  return version!.id;
}

/**
 * A correction of form: applied at once when the Secretaría or the Mesa
 * make it, waiting for the Secretaría when a presenter proposes it.
 */
export async function createFormCorrection(
  ctx: DocumentRouteContext,
  body: FormCorrectionBody,
): Promise<FormCorrectionsDto> {
  const { actor, assembly } = ctx;
  if (!hasApprovedText(ctx.document)) {
    fail(409, "El documento no tiene un texto aprobado que corregir");
  }
  if (!formCorrectionMode(actor, ctx.document)) {
    fail(403, "No puedes corregir el texto aprobado de este documento");
  }
  const contentHash = await hashBlocks(body.blocks);

  const cleanup: SigningFiles[] = [];
  await db.transaction(async (tx) => {
    const document = await lockDocument(tx, ctx.document.id);
    const mode = formCorrectionMode(actor, document);
    if (!mode) {
      fail(403, "No puedes corregir el texto aprobado de este documento");
    }
    if (document.consolidatedVersionId !== body.fromVersionId) {
      fail(409, STALE_MESSAGE, { stale: true, ...STALE_WRITE_DATA });
    }
    const [from] = await tx
      .select({
        contentHash: documentVersions.contentHash,
        pendingPassages: documentVersions.pendingPassages,
      })
      .from(documentVersions)
      .where(eq(documentVersions.id, body.fromVersionId));
    if (storedPendingPassages(from?.pendingPassages).length > 0) {
      fail(409, PENDING_MESSAGE, PENDING_CONCILIATION_DATA);
    }
    if (from?.contentHash === contentHash) {
      fail(422, "El texto no tiene ningún cambio", {
        reason: FORM_CORRECTION_NO_CHANGE_REASON,
      });
    }

    const now = new Date();
    const direct = mode === "direct";
    const resultVersionId = direct
      ? await applyText(
          tx,
          document,
          { blocks: body.blocks, contentHash, reason: body.reason },
          actor,
          cleanup,
        )
      : null;
    const [row] = await tx
      .insert(documentFormCorrections)
      .values({
        assemblyId: assembly.id,
        documentId: document.id,
        fromVersionId: body.fromVersionId,
        blocks: body.blocks,
        contentHash,
        reason: body.reason,
        status: direct ? "applied" : "pending",
        madeAs: madeAsOf(actor),
        proposedByUserId: actor.user.id,
        resultVersionId,
        decidedByUserId: direct ? actor.user.id : null,
        decidedAt: direct ? now : null,
      })
      .returning({ id: documentFormCorrections.id });
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: direct
        ? "document_form_corrected"
        : "document_form_correction_proposed",
      payload: {
        correctionId: row!.id,
        reason: body.reason,
        madeAs: madeAsOf(actor),
        ...(resultVersionId ? { versionId: resultVersionId } : {}),
      },
      actor,
    });
  });
  await removeAllSigningFiles(cleanup);

  return listFormCorrections(ctx);
}

async function lockCorrection(
  tx: Executor,
  documentId: string,
  correctionId: string,
): Promise<CorrectionRow> {
  const [row] = await tx
    .select()
    .from(documentFormCorrections)
    .where(
      and(
        eq(documentFormCorrections.id, correctionId),
        eq(documentFormCorrections.documentId, documentId),
      ),
    )
    .for("update");
  if (!row) fail(404, "Corrección no encontrada");
  return row;
}

/**
 * The Secretaría applies a presenter's proposal (it must have been made
 * on the text in force) or rejects it, with a note.
 */
export async function decideFormCorrection(
  ctx: DocumentRouteContext,
  correctionId: string,
  body: FormCorrectionDecisionBody,
): Promise<FormCorrectionsDto> {
  const { actor, assembly } = ctx;
  if (!canManageDocuments(actor)) {
    fail(403, "Solo la Secretaría valida las correcciones propuestas");
  }
  const cleanup: SigningFiles[] = [];
  await db.transaction(async (tx) => {
    const document = await lockDocument(tx, ctx.document.id);
    const row = await lockCorrection(tx, document.id, correctionId);
    assertOptimisticLock(
      body.updatedAt,
      row.updatedAt,
      "La corrección ha cambiado. Recarga la página",
    );
    if (row.status !== "pending") {
      fail(409, "La corrección ya no está pendiente");
    }
    const now = new Date();
    if (body.decision === "reject") {
      await tx
        .update(documentFormCorrections)
        .set({
          status: "rejected",
          decidedByUserId: actor.user.id,
          decidedAt: now,
          decisionNote: body.note ?? null,
        })
        .where(eq(documentFormCorrections.id, row.id));
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "document",
        entityId: document.id,
        documentId: document.id,
        type: "document_form_correction_rejected",
        payload: { correctionId: row.id, note: body.note ?? null },
        actor,
      });
      return;
    }
    if (!hasApprovedText(document)) {
      fail(409, "El documento ya no tiene un texto aprobado");
    }
    // A conciliation is a wording of its own passage over the base: other
    // passages conciliated since leave it as it was, so it applies while
    // its passage is still pending (conciliatedText).
    if (row.passage) {
      await applyConciliation(
        tx,
        ctx,
        document,
        row.passage,
        {
          reason: row.reason,
          madeAs: row.madeAs,
          correctionId: row.id,
          proposedByUserId: row.proposedByUserId,
          note: body.note ?? null,
        },
        cleanup,
      );
      return;
    }
    if (document.consolidatedVersionId !== row.fromVersionId) {
      fail(
        409,
        "Otra corrección ha cambiado el texto desde esta propuesta: corrígelo directamente con lo que proponía",
        // `stale` is the flag before ARQ-1: drop it in the release after.
        { reason: FORM_CORRECTION_STALE_REASON, stale: true },
      );
    }
    if ((await pendingOf(tx, document.consolidatedVersionId)).length > 0) {
      fail(409, PENDING_MESSAGE, PENDING_CONCILIATION_DATA);
    }
    const versionId = await applyText(
      tx,
      document,
      { blocks: row.blocks, contentHash: row.contentHash, reason: row.reason },
      actor,
      cleanup,
    );
    await tx
      .update(documentFormCorrections)
      .set({
        status: "applied",
        resultVersionId: versionId,
        decidedByUserId: actor.user.id,
        decidedAt: now,
        decisionNote: body.note ?? null,
      })
      .where(eq(documentFormCorrections.id, row.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: "document_form_corrected",
      payload: {
        correctionId: row.id,
        reason: row.reason,
        madeAs: row.madeAs,
        versionId,
        validated: true,
      },
      actor,
    });
  });
  await removeAllSigningFiles(cleanup);
  return listFormCorrections(ctx);
}

/** Its author withdraws a proposal still waiting. */
export async function withdrawFormCorrection(
  ctx: DocumentRouteContext,
  correctionId: string,
  body: FormCorrectionWithdrawBody,
): Promise<FormCorrectionsDto> {
  const { actor, assembly } = ctx;
  await db.transaction(async (tx) => {
    const document = await lockDocument(tx, ctx.document.id);
    const row = await lockCorrection(tx, document.id, correctionId);
    if (row.proposedByUserId !== actor.user.id) {
      fail(403, "Solo quien la propuso puede retirar la corrección");
    }
    assertOptimisticLock(
      body.updatedAt,
      row.updatedAt,
      "La corrección ha cambiado. Recarga la página",
    );
    if (row.status !== "pending") {
      fail(409, "La corrección ya no está pendiente");
    }
    await tx
      .update(documentFormCorrections)
      .set({ status: "withdrawn", decidedAt: new Date() })
      .where(eq(documentFormCorrections.id, row.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: "document_form_correction_withdrawn",
      payload: { correctionId: row.id },
      actor,
    });
  });
  return listFormCorrections(ctx);
}

// Conciliations ----------------------------------------------------------------

/**
 * Passages approved pending conciliation (user's decisions of 2026-11-21;
 * shared/utils/content/pendingPassages.ts). The final vote may leave
 * passages where approved amendments collide unworded; each one is then
 * conciliated as a correction of form is made: directly by whoever holds
 * document:correct_form, proposed by its presenters for the Secretaría to
 * apply or reject. A conciliation is the passage's wording over the base
 * (stored in `passage_wordings`, so a later rebuild keeps it) and the whole
 * text rebuilt with it, which replaces the version in force without that
 * passage among the pending ones. Corrections of form wait until none is
 * pending.
 */

/** The wording a conciliation tries before it is stored. */
const TRIAL_WORDING = "conciliation";

/** The passages a consolidated version leaves pending conciliation. */
async function pendingOf(
  executor: Executor,
  versionId: string | null,
): Promise<PendingPassage[]> {
  if (!versionId) return [];
  const [row] = await executor
    .select({ pending: documentVersions.pendingPassages })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId));
  return storedPendingPassages(row?.pending);
}

interface ConciliatedText {
  blocks: Block[];
  contentHash: string;
  /** The passages that stay pending after it. */
  pending: PendingPassage[];
  passage: ConciliationPassage;
  /** The codes of the amendments it conciliates, for the record. */
  codes: (string | null)[];
}

/**
 * The approved text with a pending passage worded: rebuilt from the base
 * with the approved amendments in approval order (as the final vote built
 * it) and every wording, the stored ones and this one. The passage must be
 * pending in the version in force, and the wording may only change it.
 */
async function conciliatedText(
  tx: Executor,
  document: PresentedDocumentRow,
  input: Pick<ConciliationBody, "amendmentIds" | "blockIds" | "ops">,
): Promise<ConciliatedText> {
  const key = passageKey(input.amendmentIds, input.blockIds);
  const pending = await pendingOf(tx, document.consolidatedVersionId);
  const target = pending.find((passage) => passage.key === key);
  if (!target) {
    fail(
      409,
      "Ese pasaje ya no está pendiente de conciliar. Recarga la página",
      // `code` is the shape before ARQ-1: drop it in the release after.
      { reason: PASSAGE_CHANGED_REASON, code: PASSAGE_CHANGED_REASON },
    );
  }
  if (!document.baseVersionId) fail(409, "El documento no tiene texto base");
  const [base] = await tx
    .select({ blocks: documentVersions.blocks })
    .from(documentVersions)
    .where(eq(documentVersions.id, document.baseVersionId));
  if (!base) fail(409, "El documento no tiene texto base");
  const [approved, stored] = await Promise.all([
    approvedRows(tx, document.id),
    loadPassageWordings(tx, document.id),
  ]);
  const outcome = consolidateApproved(base.blocks, approved, {
    wordings: [
      ...wordingInputs(stored.filter((row) => row.passageKey !== key)),
      {
        id: TRIAL_WORDING,
        amendmentIds: input.amendmentIds,
        blockIds: input.blockIds,
        ops: input.ops,
      },
    ],
  });
  if (
    !outcome.passages.some(
      (passage) => passage.key === key && passage.wordingId === TRIAL_WORDING,
    )
  ) {
    fail(422, "La redacción solo puede cambiar el texto de ese pasaje", {
      reason: WORDING_OUTSIDE_REASON,
      code: WORDING_OUTSIDE_REASON,
    });
  }
  const remaining = new Set(pending.map((passage) => passage.key));
  remaining.delete(key);
  return {
    blocks: outcome.blocks,
    contentHash: await hashBlocks(outcome.blocks),
    pending: pendingPassagesOf(outcome, remaining),
    passage: {
      key,
      amendmentIds: target.amendmentIds,
      blockIds: target.blockIds,
      ops: input.ops,
    },
    codes: target.amendmentIds.map(
      (id) => approved.find((row) => row.id === id)?.code ?? null,
    ),
  };
}

/**
 * Stores the passage's wording, so that rebuilding the text (the next
 * conciliation, a new final vote after an annulment) keeps it.
 */
async function storeWording(
  tx: Executor,
  documentId: string,
  passage: ConciliationPassage,
  userId: string,
  createdByUserId: string | null,
): Promise<void> {
  await tx
    .insert(passageWordings)
    .values({
      documentId,
      passageKey: passage.key,
      amendmentIds: passage.amendmentIds,
      blockIds: passage.blockIds,
      ops: passage.ops,
      note: null,
      createdByUserId: createdByUserId ?? userId,
      updatedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [passageWordings.documentId, passageWordings.passageKey],
      set: {
        amendmentIds: passage.amendmentIds,
        blockIds: passage.blockIds,
        ops: passage.ops,
        updatedByUserId: userId,
        updatedAt: new Date(),
      },
    });
}

/** The Secretaría applies a presenter's proposed conciliation. */
async function applyConciliation(
  tx: Executor,
  ctx: DocumentRouteContext,
  document: PresentedDocumentRow,
  passage: ConciliationPassage,
  row: {
    reason: string;
    madeAs: string;
    correctionId: string;
    proposedByUserId: string | null;
    note: string | null;
  },
  cleanup: SigningFiles[],
): Promise<void> {
  const { actor, assembly } = ctx;
  // Refused once its passage is no longer pending (passage_changed).
  const text = await conciliatedText(tx, document, passage);
  await storeWording(
    tx,
    document.id,
    text.passage,
    actor.user.id,
    row.proposedByUserId,
  );
  const versionId = await applyText(
    tx,
    document,
    {
      blocks: text.blocks,
      contentHash: text.contentHash,
      reason: row.reason,
      pendingPassages: text.pending,
    },
    actor,
    cleanup,
  );
  await tx
    .update(documentFormCorrections)
    .set({
      status: "applied",
      resultVersionId: versionId,
      decidedByUserId: actor.user.id,
      decidedAt: new Date(),
      decisionNote: row.note,
    })
    .where(eq(documentFormCorrections.id, row.correctionId));
  await recordEvent(tx, {
    assemblyId: assembly.id,
    entityType: "document",
    entityId: document.id,
    documentId: document.id,
    type: "passage_conciliated",
    payload: {
      correctionId: row.correctionId,
      codes: text.codes,
      reason: row.reason || null,
      madeAs: row.madeAs,
      versionId,
      validated: true,
    },
    actor,
  });
}

/**
 * Conciliates a passage the final vote left pending (POST
 * .../conciliations): applied at once with document:correct_form, waiting
 * for the Secretaría when a presenter proposes it.
 */
export async function createConciliation(
  ctx: DocumentRouteContext,
  body: ConciliationBody,
): Promise<FormCorrectionsDto> {
  const { actor, assembly } = ctx;
  if (!hasApprovedText(ctx.document)) {
    fail(409, "El documento no tiene un texto aprobado que conciliar");
  }
  if (!formCorrectionMode(actor, ctx.document)) {
    fail(403, "No puedes conciliar el texto aprobado de este documento");
  }

  const cleanup: SigningFiles[] = [];
  await db.transaction(async (tx) => {
    const document = await lockDocument(tx, ctx.document.id);
    const mode = formCorrectionMode(actor, document);
    if (!mode) {
      fail(403, "No puedes conciliar el texto aprobado de este documento");
    }
    if (document.consolidatedVersionId !== body.fromVersionId) {
      fail(409, STALE_MESSAGE, { stale: true, ...STALE_WRITE_DATA });
    }
    const text = await conciliatedText(tx, document, body);
    const direct = mode === "direct";
    const reason = body.reason ?? "";
    const madeAs = madeAsOf(actor);
    if (direct) {
      await storeWording(tx, document.id, text.passage, actor.user.id, null);
    }
    const resultVersionId = direct
      ? await applyText(
          tx,
          document,
          {
            blocks: text.blocks,
            contentHash: text.contentHash,
            reason,
            pendingPassages: text.pending,
          },
          actor,
          cleanup,
        )
      : null;
    const now = new Date();
    const [row] = await tx
      .insert(documentFormCorrections)
      .values({
        assemblyId: assembly.id,
        documentId: document.id,
        fromVersionId: body.fromVersionId,
        blocks: text.blocks,
        contentHash: text.contentHash,
        reason,
        status: direct ? "applied" : "pending",
        madeAs,
        proposedByUserId: actor.user.id,
        resultVersionId,
        decidedByUserId: direct ? actor.user.id : null,
        decidedAt: direct ? now : null,
        passage: text.passage,
      })
      .returning({ id: documentFormCorrections.id });
    await recordEvent(tx, {
      assemblyId: assembly.id,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: direct ? "passage_conciliated" : "passage_conciliation_proposed",
      payload: {
        correctionId: row!.id,
        codes: text.codes,
        reason: body.reason ?? null,
        madeAs,
        ...(resultVersionId ? { versionId: resultVersionId } : {}),
      },
      actor,
    });
  });
  await removeAllSigningFiles(cleanup);

  return listFormCorrections(ctx);
}

/** How many proposals wait for the Secretaría, per document. */
export async function countPendingFormCorrections(
  documentIds: string[],
  executor: Executor = db,
): Promise<Map<string, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await executor
    .select({ documentId: documentFormCorrections.documentId })
    .from(documentFormCorrections)
    .where(
      and(
        inArray(documentFormCorrections.documentId, documentIds),
        eq(documentFormCorrections.status, "pending"),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.documentId, (counts.get(row.documentId) ?? 0) + 1);
  }
  return counts;
}

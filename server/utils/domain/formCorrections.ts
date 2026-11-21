import { createError } from "h3";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  documentFormCorrections,
  documents,
  documentVersions,
} from "../../db/schema";
import { assertOptimisticLock } from "../optimisticLock";
import { canManageDocuments, canModerate, type Actor } from "./actor";
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
  FormCorrectionAuthor,
  FormCorrectionBody,
  FormCorrectionDecisionBody,
  FormCorrectionDto,
  FormCorrectionsDto,
  FormCorrectionWithdrawBody,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";

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
 * (409 `stale`), and so is applying a proposal another correction
 * overtook. Annulling the final vote voids the proposals still waiting
 * (voidPendingFormCorrections).
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type CorrectionRow = typeof documentFormCorrections.$inferSelect;

function fail(statusCode: number, message: string, data?: unknown): never {
  throw createError({
    statusCode,
    message,
    ...(data === undefined ? {} : { data }),
  });
}

const STALE_MESSAGE =
  "El texto aprobado ha cambiado desde que lo abriste. Recarga la página";

/** Reads the corrections that are not applied (and their texts). */
function seesUnapplied(actor: Actor, document: PresentedDocumentRow): boolean {
  return (
    canManageDocuments(actor) ||
    canModerate(actor) ||
    isProponentSide(actor, document)
  );
}

function madeAsOf(actor: Actor): FormCorrectionAuthor {
  if (canManageDocuments(actor)) return "secretaria";
  if (canModerate(actor)) return "mesa";
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
    const onCurrentText = row.fromVersionId === current;
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
  input: { blocks: Block[]; contentHash: string; reason: string },
  actor: Actor,
): Promise<string> {
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: document.id,
      number: await nextVersionNumber(tx, document.id),
      kind: "consolidated",
      blocks: input.blocks,
      contentHash: input.contentHash,
      note: input.reason,
      replacesVersionId: document.consolidatedVersionId,
      createdByUserId: actor.user.id,
    })
    .returning({ id: documentVersions.id });
  await tx
    .update(documents)
    .set({ consolidatedVersionId: version!.id })
    .where(eq(documents.id, document.id));
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

  await db.transaction(async (tx) => {
    const document = await lockDocument(tx, ctx.document.id);
    const mode = formCorrectionMode(actor, document);
    if (!mode) {
      fail(403, "No puedes corregir el texto aprobado de este documento");
    }
    if (document.consolidatedVersionId !== body.fromVersionId) {
      fail(409, STALE_MESSAGE, { stale: true });
    }
    const [from] = await tx
      .select({ contentHash: documentVersions.contentHash })
      .from(documentVersions)
      .where(eq(documentVersions.id, body.fromVersionId));
    if (from?.contentHash === contentHash) {
      fail(422, "El texto no tiene ningún cambio", {
        reason: "no_change",
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
    if (document.consolidatedVersionId !== row.fromVersionId) {
      fail(
        409,
        "Otra corrección ha cambiado el texto desde esta propuesta: corrígelo directamente con lo que proponía",
        { stale: true },
      );
    }
    const versionId = await applyText(
      tx,
      document,
      { blocks: row.blocks, contentHash: row.contentHash, reason: row.reason },
      actor,
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

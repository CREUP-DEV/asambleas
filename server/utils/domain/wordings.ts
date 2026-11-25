import { fail } from "../core/http";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  amendments,
  documents,
  documentVersions,
  passageWordings,
} from "../../db/schema";
import type {
  PassageWordingBody,
  PassageWordingDto,
} from "../../../shared/types/api";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { inApprovalOrder } from "../../../shared/utils/approvalOrder";
import { isEntityId } from "../../../shared/utils/schemas/primitives";
import {
  consolidateApproved,
  passageKey,
  type ApprovedConsolidation,
  type PassageWordingInput,
} from "../../../shared/utils/content/passages";
import { canRecordResults } from "./actor";
import { documentVoted, type DocumentAmendmentContext } from "./amendments";
import { recordEvent } from "./events";

/**
 * The Mesa's wordings of passages where approved amendments collide
 * (shared/utils/content/passages.ts; user's decisions of 2026-11-19). The
 * Mesa sets one when it approves the amendment or later, until the final
 * vote fixes the text.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type WordingRow = typeof passageWordings.$inferSelect;

export function toPassageWordingDto(row: WordingRow): PassageWordingDto {
  return {
    id: row.id,
    amendmentIds: row.amendmentIds,
    blockIds: row.blockIds,
    ops: row.ops,
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function loadPassageWordings(
  executor: Executor,
  documentId: string,
): Promise<WordingRow[]> {
  return executor
    .select()
    .from(passageWordings)
    .where(eq(passageWordings.documentId, documentId))
    .orderBy(asc(passageWordings.createdAt));
}

/** What consolidateApproved takes of the stored wordings. */
export function wordingInputs(
  rows: readonly WordingRow[],
): PassageWordingInput[] {
  return rows.map((row) => ({
    id: row.id,
    amendmentIds: row.amendmentIds,
    blockIds: row.blockIds,
    ops: row.ops,
  }));
}

interface ApprovedRow {
  id: string;
  code: string | null;
  number: number | null;
  decidedAt: Date | null;
  ops: AmendmentOp[];
}

/** The document's approved amendments, in approval order. */
export async function approvedRows(
  executor: Executor,
  documentId: string,
): Promise<ApprovedRow[]> {
  const rows = await executor
    .select({
      id: amendments.id,
      code: amendments.code,
      number: amendments.number,
      decidedAt: amendments.decidedAt,
      ops: amendments.ops,
    })
    .from(amendments)
    .where(
      and(
        eq(amendments.documentId, documentId),
        eq(amendments.status, "approved"),
      ),
    );
  return inApprovalOrder(rows);
}

/**
 * The approved text of a structured document as it stands: its base with
 * the approved amendments in approval order and the Mesa's wordings. Null
 * without a base.
 */
export async function consolidateDocument(
  executor: Executor,
  document: { id: string; baseVersionId: string | null },
): Promise<ApprovedConsolidation | null> {
  if (!document.baseVersionId) return null;
  const [base] = await executor
    .select({ blocks: documentVersions.blocks })
    .from(documentVersions)
    .where(eq(documentVersions.id, document.baseVersionId));
  if (!base) return null;
  const [approved, wordings] = await Promise.all([
    approvedRows(executor, document.id),
    loadPassageWordings(executor, document.id),
  ]);
  return consolidateApproved(base.blocks as Block[], approved, {
    wordings: wordingInputs(wordings),
  });
}

function assertCanWord(ctx: DocumentAmendmentContext): void {
  if (!canRecordResults(ctx.actor)) {
    fail(403, "No tienes permiso para realizar esta acción");
  }
  if (documentVoted(ctx.document)) fail(409, "El documento ya se ha votado");
  if (ctx.document.format !== "structured" || !ctx.document.baseVersionId) {
    fail(409, "El documento no tiene texto base");
  }
}

/** The document row under a share lock, refused once its text is final. */
async function lockOpenDocument(tx: Tx, documentId: string): Promise<void> {
  const [row] = await tx
    .select({
      finalVoteId: documents.finalVoteId,
      consolidatedVersionId: documents.consolidatedVersionId,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for("share");
  if (!row) fail(404, "Documento no encontrado");
  if (documentVoted(row)) fail(409, "El documento ya se ha votado");
}

/**
 * Sets the Mesa's wording of a passage (PUT .../wordings): the passage must
 * be one the approved amendments form now, and the wording may only change
 * its blocks. Setting it again for the same passage replaces it.
 */
export async function setPassageWording(
  ctx: DocumentAmendmentContext,
  body: PassageWordingBody,
): Promise<PassageWordingDto> {
  assertCanWord(ctx);
  const { actor, assembly, document } = ctx;
  const key = passageKey(body.amendmentIds, body.blockIds);

  return db.transaction(async (tx) => {
    await lockOpenDocument(tx, document.id);
    const [base] = await tx
      .select({ blocks: documentVersions.blocks })
      .from(documentVersions)
      .where(eq(documentVersions.id, document.baseVersionId!));
    if (!base) fail(409, "El documento no tiene texto base");
    const blocks = base.blocks as Block[];
    const approved = await approvedRows(tx, document.id);
    const now = consolidateApproved(blocks, approved);
    if (!now.passages.some((passage) => passage.key === key)) {
      fail(409, "Ese pasaje ha cambiado. Recarga la página", {
        code: "passage_changed",
      });
    }
    const trial = consolidateApproved(blocks, approved, {
      wordings: [
        {
          id: "trial",
          amendmentIds: body.amendmentIds,
          blockIds: body.blockIds,
          ops: body.ops,
        },
      ],
    });
    if (
      !trial.passages.some(
        (passage) => passage.key === key && passage.wordingId === "trial",
      )
    ) {
      fail(422, "La redacción solo puede cambiar el texto de ese pasaje", {
        code: "wording_outside",
      });
    }

    const amendmentIds = approved
      .map((row) => row.id)
      .filter((id) => body.amendmentIds.includes(id));
    const [row] = await tx
      .insert(passageWordings)
      .values({
        documentId: document.id,
        passageKey: key,
        amendmentIds,
        blockIds: body.blockIds,
        ops: body.ops,
        note: body.note ?? null,
        createdByUserId: actor.user.id,
        updatedByUserId: actor.user.id,
      })
      .onConflictDoUpdate({
        target: [passageWordings.documentId, passageWordings.passageKey],
        set: {
          amendmentIds,
          blockIds: body.blockIds,
          ops: body.ops,
          note: body.note ?? null,
          updatedByUserId: actor.user.id,
          updatedAt: new Date(),
        },
      })
      .returning();
    await recordEvent(tx, {
      assemblyId: assembly.id,
      documentId: document.id,
      entityType: "document",
      entityId: document.id,
      type: "passage_worded",
      payload: {
        wordingId: row!.id,
        amendmentIds,
        codes: amendmentIds.map(
          (id) => approved.find((item) => item.id === id)?.code ?? null,
        ),
      },
      actor,
    });
    return toPassageWordingDto(row!);
  });
}

/**
 * Removes a wording (DELETE .../wordings/[wording]): its passage goes back
 * to the automatic proposal.
 */
export async function removePassageWording(
  ctx: DocumentAmendmentContext,
  wordingParam: string | undefined,
): Promise<{ success: true }> {
  assertCanWord(ctx);
  const { actor, assembly, document } = ctx;
  if (!isEntityId(wordingParam)) {
    fail(404, "Redacción no encontrada");
  }
  await db.transaction(async (tx) => {
    await lockOpenDocument(tx, document.id);
    const [row] = await tx
      .delete(passageWordings)
      .where(
        and(
          eq(passageWordings.id, wordingParam),
          eq(passageWordings.documentId, document.id),
        ),
      )
      .returning();
    if (!row) fail(404, "Redacción no encontrada");
    const codes = await tx
      .select({ id: amendments.id, code: amendments.code })
      .from(amendments)
      .where(eq(amendments.documentId, document.id));
    await recordEvent(tx, {
      assemblyId: assembly.id,
      documentId: document.id,
      entityType: "document",
      entityId: document.id,
      type: "passage_wording_removed",
      payload: {
        wordingId: row.id,
        amendmentIds: row.amendmentIds,
        codes: row.amendmentIds.map(
          (id) => codes.find((item) => item.id === id)?.code ?? null,
        ),
      },
      actor,
    });
  });
  return { success: true };
}

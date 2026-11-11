import type { H3Event } from "h3";
import { createError } from "h3";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "../../db";
import { documentNotes } from "../../db/schema";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type {
  DocumentNoteCreateBody,
  DocumentNoteDto,
  DocumentNotesDto,
  DocumentNoteUpdateBody,
} from "~~/shared/types/api";
import { DOCUMENT_NOTES_MAX } from "~~/shared/utils/documentNotes";
import { getOptimisticLockTimestampMs } from "../optimisticLock";
import type { Actor } from "./actor";
import { recordAudit } from "./audit";
import type { DocumentRouteContext } from "./documents";

/**
 * Private notes of an account on a published document (docs/design.md,
 * "Private notes"). They are the account's own: every read and write here
 * is keyed by `actor.user.id`, so no path returns or changes another
 * account's.
 *
 * An Admin acting as the account is that account here as everywhere else:
 * it reads its notes and writes them, and what it writes is recorded under
 * the impersonation. The activity records that a note was written, changed
 * or deleted, never its text nor where in the document it is.
 */

type NoteRow = typeof documentNotes.$inferSelect;

function toDto(row: NoteRow): DocumentNoteDto {
  return {
    id: row.id,
    anchor:
      row.blockId !== null && row.startOffset !== null && row.endOffset !== null
        ? {
            blockId: row.blockId,
            from: row.startOffset,
            to: row.endOffset,
            quote: row.quote ?? "",
          }
        : null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Whether notes can be kept on the document now: a published one. */
function notesAvailable(ctx: DocumentRouteContext): boolean {
  return ctx.document.status === "published";
}

function requireAvailable(ctx: DocumentRouteContext): void {
  if (!notesAvailable(ctx)) {
    throw createError({
      statusCode: 409,
      message: "Solo se pueden anotar documentos publicados",
    });
  }
}

function ownNote(actor: Actor, documentId: string, noteId: string) {
  return and(
    eq(documentNotes.id, noteId),
    eq(documentNotes.userId, actor.user.id),
    eq(documentNotes.documentId, documentId),
  );
}

function notFound(): never {
  throw createError({ statusCode: 404, message: "Nota no encontrada" });
}

/** The account's notes on the document, oldest first. */
export async function listDocumentNotes(
  ctx: DocumentRouteContext,
): Promise<DocumentNotesDto> {
  if (!notesAvailable(ctx)) return { available: false, notes: [] };
  const rows = await db
    .select()
    .from(documentNotes)
    .where(
      and(
        eq(documentNotes.userId, ctx.actor.user.id),
        eq(documentNotes.documentId, ctx.document.id),
      ),
    )
    .orderBy(asc(documentNotes.createdAt), asc(documentNotes.id));
  return { available: true, notes: rows.map(toDto) };
}

export async function createDocumentNote(
  event: H3Event,
  ctx: DocumentRouteContext,
  body: DocumentNoteCreateBody,
): Promise<DocumentNoteDto> {
  requireAvailable(ctx);
  const { actor, assembly, document } = ctx;
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ total: count() })
      .from(documentNotes)
      .where(
        and(
          eq(documentNotes.userId, actor.user.id),
          eq(documentNotes.documentId, document.id),
        ),
      );
    if ((existing?.total ?? 0) >= DOCUMENT_NOTES_MAX) {
      throw createError({
        statusCode: 409,
        message: "Has llegado al máximo de notas en este documento",
      });
    }
    const anchor = body.anchor ?? null;
    const [row] = await tx
      .insert(documentNotes)
      .values({
        userId: actor.user.id,
        documentId: document.id,
        blockId: anchor?.blockId ?? null,
        startOffset: anchor?.from ?? null,
        endOffset: anchor?.to ?? null,
        quote: anchor?.quote ?? null,
        body: body.body.trim(),
      })
      .returning();
    await recordAudit(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.DOCUMENT_NOTE_CREATED,
      targetType: "document",
      targetId: document.id,
      assemblyId: assembly.id,
      after: { anchored: anchor !== null },
    });
    return toDto(row!);
  });
}

export async function updateDocumentNote(
  event: H3Event,
  ctx: DocumentRouteContext,
  noteId: string,
  body: DocumentNoteUpdateBody,
): Promise<DocumentNoteDto> {
  requireAvailable(ctx);
  const { actor, assembly, document } = ctx;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(documentNotes)
      .where(ownNote(actor, document.id, noteId))
      .for("update");
    if (!current) notFound();
    // The account may be open in several places: the later save says so.
    if (
      getOptimisticLockTimestampMs(body.updatedAt) !==
      getOptimisticLockTimestampMs(current.updatedAt)
    ) {
      throw createError({
        statusCode: 409,
        message: "La nota ha cambiado desde que la abriste",
      });
    }
    const [row] = await tx
      .update(documentNotes)
      .set({ body: body.body.trim() })
      .where(eq(documentNotes.id, current.id))
      .returning();
    await recordAudit(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.DOCUMENT_NOTE_UPDATED,
      targetType: "document",
      targetId: document.id,
      assemblyId: assembly.id,
      after: { anchored: current.blockId !== null },
    });
    return toDto(row!);
  });
}

export async function deleteDocumentNote(
  event: H3Event,
  ctx: DocumentRouteContext,
  noteId: string,
): Promise<void> {
  requireAvailable(ctx);
  const { actor, assembly, document } = ctx;
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(documentNotes)
      .where(ownNote(actor, document.id, noteId))
      .returning({ blockId: documentNotes.blockId });
    if (!removed) notFound();
    await recordAudit(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.DOCUMENT_NOTE_DELETED,
      targetType: "document",
      targetId: document.id,
      assemblyId: assembly.id,
      before: { anchored: removed.blockId !== null },
    });
  });
}

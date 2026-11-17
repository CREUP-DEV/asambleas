import type { H3Event } from "h3";
import { createError } from "h3";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "../../db";
import { amendmentNotes } from "../../db/schema";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type {
  AmendmentNoteCreateBody,
  AmendmentNoteDto,
  AmendmentNotesDto,
  AmendmentNoteUpdateBody,
} from "~~/shared/types/api";
import { AMENDMENT_NOTES_MAX } from "~~/shared/utils/amendmentNotes";
import { getOptimisticLockTimestampMs } from "../optimisticLock";
import type { Actor } from "./actor";
import type { AmendmentContext } from "./amendments";
import { recordAudit } from "./audit";

/**
 * Private notes of an account on an amendment it reads (docs/design.md,
 * "Private notes"), about the whole amendment. Like the notes on a
 * document they are the account's own: every read and write here is keyed
 * by `actor.user.id`, so no path returns or changes another account's. The
 * amendment comes from loadAmendmentContext, which answers 404 for one the
 * account may not read; a draft takes none.
 *
 * An Admin acting as the account is that account here as everywhere else.
 * The activity records that a note was written, changed or deleted, on the
 * amendment's document, never its text.
 */

type NoteRow = typeof amendmentNotes.$inferSelect;

function toDto(row: NoteRow): AmendmentNoteDto {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notesAvailable(ctx: AmendmentContext): boolean {
  return ctx.amendment.status !== "draft";
}

function requireAvailable(ctx: AmendmentContext): void {
  if (!notesAvailable(ctx)) {
    throw createError({
      statusCode: 409,
      message: "Solo se pueden anotar enmiendas presentadas",
    });
  }
}

function ownNote(actor: Actor, amendmentId: string, noteId: string) {
  return and(
    eq(amendmentNotes.id, noteId),
    eq(amendmentNotes.userId, actor.user.id),
    eq(amendmentNotes.amendmentId, amendmentId),
  );
}

function notFound(): never {
  throw createError({ statusCode: 404, message: "Nota no encontrada" });
}

function auditTarget(ctx: AmendmentContext) {
  return {
    targetType: "document" as const,
    targetId: ctx.document.id,
    assemblyId: ctx.assembly.id,
  };
}

/** The account's notes on the amendment, oldest first. */
export async function listAmendmentNotes(
  ctx: AmendmentContext,
): Promise<AmendmentNotesDto> {
  if (!notesAvailable(ctx)) return { available: false, notes: [] };
  const rows = await db
    .select()
    .from(amendmentNotes)
    .where(
      and(
        eq(amendmentNotes.userId, ctx.actor.user.id),
        eq(amendmentNotes.amendmentId, ctx.amendment.id),
      ),
    )
    .orderBy(asc(amendmentNotes.createdAt), asc(amendmentNotes.id));
  return { available: true, notes: rows.map(toDto) };
}

export async function createAmendmentNote(
  event: H3Event,
  ctx: AmendmentContext,
  body: AmendmentNoteCreateBody,
): Promise<AmendmentNoteDto> {
  requireAvailable(ctx);
  const { actor, amendment } = ctx;
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ total: count() })
      .from(amendmentNotes)
      .where(
        and(
          eq(amendmentNotes.userId, actor.user.id),
          eq(amendmentNotes.amendmentId, amendment.id),
        ),
      );
    if ((existing?.total ?? 0) >= AMENDMENT_NOTES_MAX) {
      throw createError({
        statusCode: 409,
        message: "Has llegado al máximo de notas en esta enmienda",
      });
    }
    const [row] = await tx
      .insert(amendmentNotes)
      .values({
        userId: actor.user.id,
        amendmentId: amendment.id,
        body: body.body.trim(),
      })
      .returning();
    await recordAudit(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.AMENDMENT_NOTE_CREATED,
      ...auditTarget(ctx),
    });
    return toDto(row!);
  });
}

export async function updateAmendmentNote(
  event: H3Event,
  ctx: AmendmentContext,
  noteId: string,
  body: AmendmentNoteUpdateBody,
): Promise<AmendmentNoteDto> {
  requireAvailable(ctx);
  const { actor, amendment } = ctx;
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(amendmentNotes)
      .where(ownNote(actor, amendment.id, noteId))
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
      .update(amendmentNotes)
      .set({ body: body.body.trim() })
      .where(eq(amendmentNotes.id, current.id))
      .returning();
    await recordAudit(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.AMENDMENT_NOTE_UPDATED,
      ...auditTarget(ctx),
    });
    return toDto(row!);
  });
}

export async function deleteAmendmentNote(
  event: H3Event,
  ctx: AmendmentContext,
  noteId: string,
): Promise<void> {
  requireAvailable(ctx);
  const { actor, amendment } = ctx;
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(amendmentNotes)
      .where(ownNote(actor, amendment.id, noteId))
      .returning({ id: amendmentNotes.id });
    if (!removed) notFound();
    await recordAudit(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.AMENDMENT_NOTE_DELETED,
      ...auditTarget(ctx),
    });
  });
}

import type { H3Event } from "h3";
import { createError } from "h3";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  amendmentAuthors,
  amendmentReads,
  amendments,
  documentReads,
  documents,
} from "../../db/schema";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type { ReadMarksBody, ReadMarksDto } from "~~/shared/types/api";
import { readStateOf } from "~~/shared/utils/readMarks";
import { actsFor, type Actor } from "./actor";
import type { AssemblyRow } from "./assemblies";
import { recordAudit } from "./audit";
import type { Executor } from "./events";
import { loadCoProponentIds } from "./presenters";

/**
 * Read marks (docs/design.md, "Read marks"): what an account marked as
 * read, by hand, among the published documents of an assembly and their
 * published amendments. Everyone who sees the assembly reads those, so the
 * marks need no visibility rule of their own; nothing else can be marked.
 *
 * A mark stores the revision it was made on. A document's is its frozen
 * base version and its PDF: publishing again after a correction, or
 * replacing the PDF, makes the mark read as "changed". An amendment's is its
 * operations and its justification.
 */

interface MarkableDocument {
  id: string;
  revision: string;
  own: boolean;
}

interface MarkableAmendment {
  id: string;
  documentId: string;
  revision: string;
  own: boolean;
  open: boolean;
}

/** What a document's mark is made on: the text and the PDF everyone reads. */
export function documentRevision(document: {
  baseVersionId: string | null;
  fileUrl: string | null;
}): string {
  return `${document.baseVersionId ?? ""}|${document.fileUrl ?? ""}`;
}

async function loadMarkable(
  actor: Actor,
  assemblyId: string,
  executor: Executor,
): Promise<{ documents: MarkableDocument[]; amendments: MarkableAmendment[] }> {
  const documentRows = await executor
    .select({
      id: documents.id,
      baseVersionId: documents.baseVersionId,
      fileUrl: documents.fileUrl,
      proponentMemberId: documents.proponentMemberId,
    })
    .from(documents)
    .where(
      and(
        eq(documents.assemblyId, assemblyId),
        eq(documents.status, "published"),
      ),
    );
  const documentIds = documentRows.map((row) => row.id);
  if (documentIds.length === 0) return { documents: [], amendments: [] };

  const [coProponents, amendmentRows] = await Promise.all([
    loadCoProponentIds(documentIds, executor),
    executor
      .select({
        id: amendments.id,
        documentId: amendments.documentId,
        status: amendments.status,
        revision: sql<string>`md5(${amendments.ops}::text || '|' || ${amendments.justification})`,
      })
      .from(amendments)
      .where(
        and(
          inArray(amendments.documentId, documentIds),
          ne(amendments.status, "draft"),
          isNotNull(amendments.publishedAt),
        ),
      ),
  ]);

  const authors = new Map<string, string[]>();
  if (actor.memberId && amendmentRows.length > 0) {
    const rows = await executor
      .select({ amendmentId: amendmentAuthors.amendmentId })
      .from(amendmentAuthors)
      .where(
        and(
          eq(amendmentAuthors.memberId, actor.memberId),
          inArray(
            amendmentAuthors.amendmentId,
            amendmentRows.map((row) => row.id),
          ),
        ),
      );
    for (const row of rows) authors.set(row.amendmentId, [actor.memberId]);
  }

  return {
    documents: documentRows.map((row) => ({
      id: row.id,
      revision: documentRevision(row),
      own: actsFor(actor, [
        row.proponentMemberId,
        ...(coProponents.get(row.id) ?? []),
      ]),
    })),
    amendments: amendmentRows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      revision: row.revision,
      own: actsFor(actor, authors.get(row.id) ?? []),
      open: row.status === "submitted",
    })),
  };
}

/** The account's read marks over everything it can mark in the assembly. */
export async function loadReadMarks(
  actor: Actor,
  assembly: Pick<AssemblyRow, "id">,
  executor: Executor = db,
): Promise<ReadMarksDto> {
  const markable = await loadMarkable(actor, assembly.id, executor);
  const documentIds = markable.documents.map((document) => document.id);
  const amendmentIds = markable.amendments.map((amendment) => amendment.id);
  const [documentMarks, amendmentMarks] = await Promise.all([
    documentIds.length > 0
      ? executor
          .select({
            id: documentReads.documentId,
            revision: documentReads.revision,
          })
          .from(documentReads)
          .where(
            and(
              eq(documentReads.userId, actor.user.id),
              inArray(documentReads.documentId, documentIds),
            ),
          )
      : [],
    amendmentIds.length > 0
      ? executor
          .select({
            id: amendmentReads.amendmentId,
            revision: amendmentReads.revision,
          })
          .from(amendmentReads)
          .where(
            and(
              eq(amendmentReads.userId, actor.user.id),
              inArray(amendmentReads.amendmentId, amendmentIds),
            ),
          )
      : [],
  ]);
  const readDocuments = new Map(
    documentMarks.map((mark) => [mark.id, mark.revision]),
  );
  const readAmendments = new Map(
    amendmentMarks.map((mark) => [mark.id, mark.revision]),
  );
  return {
    documents: markable.documents.map((document) => ({
      id: document.id,
      state: readStateOf(readDocuments.get(document.id), document.revision),
      own: document.own,
    })),
    amendments: markable.amendments.map((amendment) => ({
      id: amendment.id,
      documentId: amendment.documentId,
      state: readStateOf(readAmendments.get(amendment.id), amendment.revision),
      own: amendment.own,
      open: amendment.open,
    })),
  };
}

function unique(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

/**
 * Marks documents and amendments as read (on the revision on show now), or
 * as not read. Only what `loadReadMarks` lists can be marked: anything else
 * answers 404, whatever it is. Recorded as `read_marks.set`, with counts
 * only.
 */
export async function setReadMarks(
  event: H3Event,
  actor: Actor,
  assembly: Pick<AssemblyRow, "id">,
  body: ReadMarksBody,
): Promise<ReadMarksDto> {
  const documentIds = unique(body.documentIds);
  const amendmentIds = unique(body.amendmentIds);
  return db.transaction(async (tx) => {
    const markable = await loadMarkable(actor, assembly.id, tx);
    const documentsById = new Map(
      markable.documents.map((document) => [document.id, document]),
    );
    const amendmentsById = new Map(
      markable.amendments.map((amendment) => [amendment.id, amendment]),
    );
    if (
      documentIds.some((id) => !documentsById.has(id)) ||
      amendmentIds.some((id) => !amendmentsById.has(id))
    ) {
      throw createError({
        statusCode: 404,
        message: "Documento o enmienda no encontrados",
      });
    }

    const userId = actor.user.id;
    if (body.read) {
      const now = new Date();
      if (documentIds.length > 0) {
        await tx
          .insert(documentReads)
          .values(
            documentIds.map((id) => ({
              userId,
              documentId: id,
              revision: documentsById.get(id)!.revision,
              readAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [documentReads.userId, documentReads.documentId],
            set: { revision: sql`excluded.revision`, readAt: now },
          });
      }
      if (amendmentIds.length > 0) {
        await tx
          .insert(amendmentReads)
          .values(
            amendmentIds.map((id) => ({
              userId,
              amendmentId: id,
              revision: amendmentsById.get(id)!.revision,
              readAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [amendmentReads.userId, amendmentReads.amendmentId],
            set: { revision: sql`excluded.revision`, readAt: now },
          });
      }
    } else {
      if (documentIds.length > 0) {
        await tx
          .delete(documentReads)
          .where(
            and(
              eq(documentReads.userId, userId),
              inArray(documentReads.documentId, documentIds),
            ),
          );
      }
      if (amendmentIds.length > 0) {
        await tx
          .delete(amendmentReads)
          .where(
            and(
              eq(amendmentReads.userId, userId),
              inArray(amendmentReads.amendmentId, amendmentIds),
            ),
          );
      }
    }

    await recordAudit(tx, {
      event,
      actor,
      action: AUDIT_ACTIONS.READ_MARKS_SET,
      targetType: "assembly",
      targetId: assembly.id,
      assemblyId: assembly.id,
      after: {
        read: body.read,
        documents: documentIds.length,
        amendments: amendmentIds.length,
      },
    });

    return loadReadMarks(actor, assembly, tx);
  });
}

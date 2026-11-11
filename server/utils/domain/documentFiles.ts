import { createError } from "h3";
import { and, desc, eq, isNotNull, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db";
import { documentFiles, users } from "../../db/schema";
import { canManageDocuments } from "./actor";
import { PDF_URL_PREFIX, type DocumentRouteContext } from "./documents";
import type { DocumentFileVersionDto } from "~~/shared/types/api";

function fail(statusCode: number, message: string): never {
  throw createError({ statusCode, message });
}

const uploader = alias(users, "uploader");
const replacer = alias(users, "replacer");

/** Name of an account as the platform shows it (the Intranet's first). */
function accountName(table: { externalName: AnyColumn; name: AnyColumn }) {
  return sql<string | null>`coalesce(${table.externalName}, ${table.name})`;
}

/**
 * The PDFs a published `file` document replaced, newest replacement first.
 * Only document managers read them (the Secretaría): everyone else gets 403,
 * as the uploads route answers 404 for these files.
 */
export async function listDocumentFiles(
  ctx: DocumentRouteContext,
): Promise<DocumentFileVersionDto[]> {
  if (!canManageDocuments(ctx.actor)) {
    fail(403, "No tienes permiso para ver las versiones anteriores del PDF");
  }
  const rows = await db
    .select({
      id: documentFiles.id,
      storedName: documentFiles.storedName,
      fileName: documentFiles.fileName,
      uploadedAt: documentFiles.uploadedAt,
      replacedAt: documentFiles.replacedAt,
      uploadedBy: accountName(uploader),
      replacedBy: accountName(replacer),
      uploaderId: uploader.id,
      replacerId: replacer.id,
    })
    .from(documentFiles)
    .leftJoin(uploader, eq(uploader.id, documentFiles.uploadedByUserId))
    .leftJoin(replacer, eq(replacer.id, documentFiles.replacedByUserId))
    .where(
      and(
        eq(documentFiles.documentId, ctx.document.id),
        isNotNull(documentFiles.replacedAt),
      ),
    )
    .orderBy(desc(documentFiles.replacedAt), desc(documentFiles.id));
  return rows.map((row) => ({
    id: row.id,
    fileName: row.fileName,
    url: `${PDF_URL_PREFIX}${row.storedName}`,
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedBy: row.uploaderId ? row.uploadedBy : null,
    replacedAt: row.replacedAt!.toISOString(),
    replacedBy: row.replacerId ? row.replacedBy : null,
  }));
}

import { notFound } from "../../../utils/core/http";
import {
  createError,
  defineEventHandler,
  getRequestHeader,
  getRouterParam,
  sendNoContent,
  sendStream,
  setResponseHeaders,
} from "h3";
import { and, eq, isNotNull } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../../db";
import { assemblies, documentFiles, documents } from "../../../db/schema";
import {
  etagMatches,
  fileEtag,
  REVALIDATED_FILE_CACHE_CONTROL,
} from "../../../utils/core/fileValidators";
import { getUploadDir } from "../../../utils/core/uploadPaths";
import { canManageDocuments, requireActor } from "../../../utils/domain/actor";
import { withCoProponentIds } from "../../../utils/domain/presenters";
import {
  canSeeAssembly,
  canSeeDocument,
} from "../../../utils/domain/visibility";
import {
  cleanFileName,
  PDF_URL_PREFIX,
  STORED_PDF_NAME,
} from "../../../utils/domain/documents";

const NOT_FOUND_MESSAGE = "Documento no encontrado";

/** RFC 6266 header with an ASCII fallback and the UTF-8 name. */
function contentDisposition(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const DOCUMENT_COLUMNS = {
  id: documents.id,
  status: documents.status,
  format: documents.format,
  proponentMemberId: documents.proponentMemberId,
  submittedByUserId: documents.submittedByUserId,
  assemblyStatus: assemblies.status,
};

/**
 * Serves the PDF of a `file` document to whoever can see that document, and
 * a PDF it replaced once published (`document_files.replacedAt`) only to
 * document managers who can see it. Files nobody points to answer 404.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);

  const filename = getRouterParam(event, "filename");
  if (!filename || !STORED_PDF_NAME.test(filename)) {
    throw createError({ statusCode: 400, message: "Archivo no válido" });
  }

  const [current] = await db
    .select({ ...DOCUMENT_COLUMNS, fileName: documents.fileName })
    .from(documents)
    .innerJoin(assemblies, eq(assemblies.id, documents.assemblyId))
    .where(eq(documents.fileUrl, `${PDF_URL_PREFIX}${filename}`))
    .limit(1);
  const [replaced] = current
    ? []
    : canManageDocuments(actor)
      ? await db
          .select({ ...DOCUMENT_COLUMNS, fileName: documentFiles.fileName })
          .from(documentFiles)
          .innerJoin(documents, eq(documents.id, documentFiles.documentId))
          .innerJoin(assemblies, eq(assemblies.id, documents.assemblyId))
          .where(
            and(
              eq(documentFiles.storedName, filename),
              isNotNull(documentFiles.replacedAt),
            ),
          )
          .limit(1)
      : [];
  const row = current ?? replaced;

  if (
    !row ||
    row.format !== "file" ||
    !canSeeAssembly(actor, { status: row.assemblyStatus }) ||
    // Co-presenters see a draft like its main presenter.
    !canSeeDocument(actor, (await withCoProponentIds([row]))[0]!)
  ) {
    notFound(NOT_FOUND_MESSAGE);
  }

  const filePath = join(getUploadDir(), filename);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) notFound(NOT_FOUND_MESSAGE);

  // Kept by the browser and asked about each time, after the checks above:
  // a PDF it already holds answers 304 instead of being sent again.
  const etag = fileEtag(fileStat);
  setResponseHeaders(event, {
    "Cache-Control": REVALIDATED_FILE_CACHE_CONTROL,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
  if (etagMatches(getRequestHeader(event, "if-none-match"), etag)) {
    return sendNoContent(event, 304);
  }

  setResponseHeaders(event, {
    "Content-Type": "application/pdf",
    "Content-Disposition": contentDisposition(
      cleanFileName(row.fileName ?? "", filename),
    ),
  });

  return sendStream(event, createReadStream(filePath));
});

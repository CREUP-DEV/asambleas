import {
  createError,
  defineEventHandler,
  getRequestHeader,
  getRouterParam,
  sendNoContent,
  sendStream,
  setResponseHeaders,
} from "h3";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../../db";
import {
  agreementRecordSignings,
  assemblies,
  documents,
} from "../../../db/schema";
import {
  etagMatches,
  fileEtag,
  REVALIDATED_FILE_CACHE_CONTROL,
} from "../../../utils/core/fileValidators";
import { getUploadDir } from "../../../utils/core/uploadPaths";
import { requireActor } from "../../../utils/domain/actor";
import { AGREEMENTS_URL_PREFIX } from "../../../utils/domain/agreementsSignedFile";
import {
  cleanFileName,
  STORED_PDF_NAME,
} from "../../../utils/domain/documents";
import { withCoProponentIds } from "../../../utils/domain/presenters";
import {
  canSeeAssembly,
  canSeeDocument,
} from "../../../utils/domain/visibility";

function notFound(): never {
  throw createError({ statusCode: 404, message: "Archivo no encontrado" });
}

/** RFC 6266 header with an ASCII fallback and the UTF-8 name. */
function contentDisposition(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Serves the signed acta de acuerdos (agreementsSigning.ts) to whoever sees
 * its document, while it signs the text in force. Files no record points
 * to answer 404.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);

  const filename = getRouterParam(event, "filename");
  if (!filename || !STORED_PDF_NAME.test(filename)) {
    throw createError({ statusCode: 400, message: "Archivo no válido" });
  }

  const [row] = await db
    .select({
      id: documents.id,
      status: documents.status,
      format: documents.format,
      proponentMemberId: documents.proponentMemberId,
      submittedByUserId: documents.submittedByUserId,
      consolidatedVersionId: documents.consolidatedVersionId,
      assemblyStatus: assemblies.status,
      fileName: agreementRecordSignings.signedFileName,
      signedVersionId: agreementRecordSignings.signedVersionId,
    })
    .from(agreementRecordSignings)
    .innerJoin(documents, eq(documents.id, agreementRecordSignings.documentId))
    .innerJoin(assemblies, eq(assemblies.id, documents.assemblyId))
    .where(
      eq(
        agreementRecordSignings.signedFileUrl,
        `${AGREEMENTS_URL_PREFIX}${filename}`,
      ),
    )
    .limit(1);

  if (
    !row ||
    row.signedVersionId !== row.consolidatedVersionId ||
    !canSeeAssembly(actor, { status: row.assemblyStatus }) ||
    !canSeeDocument(actor, (await withCoProponentIds([row]))[0]!)
  ) {
    notFound();
  }

  const filePath = join(getUploadDir(), filename);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) notFound();

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

import {
  createError,
  defineEventHandler,
  getRouterParam,
  sendStream,
  setResponseHeaders,
} from "h3";
import { and, eq, isNotNull } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../../db";
import { assemblies, documentFiles, documents } from "../../../db/schema";
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

function notFound(): never {
  throw createError({ statusCode: 404, message: "Documento no encontrado" });
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
    notFound();
  }

  const filePath = join(getUploadDir(), filename);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) notFound();
  } catch {
    notFound();
  }

  setResponseHeaders(event, {
    "Content-Type": "application/pdf",
    "Content-Disposition": contentDisposition(
      cleanFileName(row.fileName ?? "", filename),
    ),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });

  return sendStream(event, createReadStream(filePath));
});

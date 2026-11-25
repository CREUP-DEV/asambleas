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
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import {
  etagMatches,
  fileEtag,
  REVALIDATED_FILE_CACHE_CONTROL,
} from "../../../utils/core/fileValidators";
import { getUploadDir } from "../../../utils/core/uploadPaths";
import { requireActor } from "../../../utils/domain/actor";
import { CONVOCATION_URL_PREFIX } from "../../../utils/domain/convocation";
import {
  cleanFileName,
  STORED_PDF_NAME,
} from "../../../utils/domain/documents";
import { canSeeAssembly } from "../../../utils/domain/visibility";

const NOT_FOUND_MESSAGE = "Convocatoria no encontrada";

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
 * Serves the signed convocatoria of an assembly to whoever sees that
 * assembly (a draft one only to managers). Files no assembly points to
 * answer 404.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);

  const filename = getRouterParam(event, "filename");
  if (!filename || !STORED_PDF_NAME.test(filename)) {
    throw createError({ statusCode: 400, message: "Archivo no válido" });
  }

  const [row] = await db
    .select({
      status: assemblies.status,
      fileName: assemblies.convocationFileName,
    })
    .from(assemblies)
    .where(
      eq(assemblies.convocationFileUrl, `${CONVOCATION_URL_PREFIX}${filename}`),
    )
    .limit(1);

  if (!row || !canSeeAssembly(actor, { status: row.status }))
    notFound(NOT_FOUND_MESSAGE);

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

import {
  createError,
  defineEventHandler,
  getRouterParam,
  sendStream,
  setResponseHeaders,
} from "h3";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import { getUploadDir } from "../../../utils/core/uploadPaths";
import { requireActor } from "../../../utils/domain/actor";
import { CONVOCATION_URL_PREFIX } from "../../../utils/domain/convocation";
import {
  cleanFileName,
  STORED_PDF_NAME,
} from "../../../utils/domain/documents";
import { canSeeAssembly } from "../../../utils/domain/visibility";

function notFound(): never {
  throw createError({ statusCode: 404, message: "Convocatoria no encontrada" });
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

  if (!row || !canSeeAssembly(actor, { status: row.status })) notFound();

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

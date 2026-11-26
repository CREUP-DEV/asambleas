import { sendReadStream } from "../../../../../../utils/core/http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createError, defineEventHandler, setResponseHeaders } from "h3";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { preparedActaFile } from "../../../../../../utils/domain/documentSigning";
import { attachmentDisposition } from "../../../../../../utils/export/package/http";

/**
 * An acta prepared to sign (document managers only): downloaded to sign it
 * outside the platform, or read by the page to sign it with AutoFirma.
 */
export default defineEventHandler(async (event) => {
  const ctx = await resolveDocumentRoute(event);
  const file = await preparedActaFile(ctx);
  const fileStat = await stat(file.path).catch(() => null);
  if (!fileStat?.isFile()) {
    throw createError({
      statusCode: 404,
      message: "No hay ningún acta preparada para firmar",
    });
  }
  setResponseHeaders(event, {
    "Content-Type": "application/pdf",
    "Content-Disposition": attachmentDisposition(file.filename),
    "Content-Length": String(fileStat.size),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  return sendReadStream(event, createReadStream(file.path));
});

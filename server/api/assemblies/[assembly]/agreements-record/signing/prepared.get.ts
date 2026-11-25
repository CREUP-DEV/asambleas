import { sendReadStream } from "../../../../../utils/core/http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createError, defineEventHandler, setResponseHeaders } from "h3";
import { requireRecordManager } from "../../../../../utils/domain/agreementsRecord";
import { preparedRecordFile } from "../../../../../utils/domain/agreementsSigning";
import { attachmentDisposition } from "../../../../../utils/export/package/http";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * The acta de acuerdos prepared to sign (Secretaría only): downloaded to
 * sign it outside the platform, or read by the page to sign it with
 * AutoFirma.
 */
export default defineEventHandler(async (event) => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireRecordManager(actor);
  const file = await preparedRecordFile(actor, assembly);
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

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  sendStream,
  setResponseHeaders,
} from "h3";
import { requireActor } from "../../../../../utils/domain/actor";
import { requireRecordManager } from "../../../../../utils/domain/agreementsRecord";
import { preparedRecordFile } from "../../../../../utils/domain/agreementsSigning";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { attachmentDisposition } from "../../../../../utils/export/package/http";

/**
 * The acta de acuerdos prepared to sign (Secretaría only): downloaded to
 * sign it outside the platform, or read by the page to sign it with
 * AutoFirma.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  requireRecordManager(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
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
  return sendStream(event, createReadStream(file.path));
});

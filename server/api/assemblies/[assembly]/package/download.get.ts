import { createReadStream } from "node:fs";
import {
  createError,
  defineEventHandler,
  sendStream,
  setResponseHeaders,
} from "h3";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { db } from "../../../../db";
import { recordAudit } from "../../../../utils/domain/audit";
import {
  attachmentDisposition,
  resolvePackageRequest,
} from "../../../../utils/export/package/http";
import { packageDownload } from "../../../../utils/export/package/service";

/**
 * Streams the documentation package (`?locale=es&editable=1`): the current
 * one, or while it is being built an earlier one whose content is all still
 * public. 409 while there is none. Recorded as `export.download`.
 */
export default defineEventHandler(async (event) => {
  const request = await resolvePackageRequest(event);
  const file = await packageDownload(
    request.assemblyId,
    request.locale,
    request.editable,
  );
  if (!file) {
    throw createError({
      statusCode: 409,
      data: { messageKey: "assembly.package.notReady" },
      message: "La documentación todavía se está preparando",
    });
  }
  await recordAudit(db, {
    event,
    actor: request.actor,
    action: AUDIT_ACTIONS.EXPORT_DOWNLOAD,
    targetType: "assembly",
    targetId: request.assemblyId,
    assemblyId: request.assemblyId,
    after: {
      package: true,
      locale: request.locale,
      editable: request.editable,
    },
  });
  setResponseHeaders(event, {
    "Content-Type": "application/zip",
    "Content-Length": String(file.bytes),
    "Content-Disposition": attachmentDisposition(file.filename),
    "Cache-Control": "private, no-store",
  });
  return sendStream(event, createReadStream(file.path));
});

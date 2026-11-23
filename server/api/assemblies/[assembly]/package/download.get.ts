import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import {
  createError,
  defineEventHandler,
  sendStream,
  setResponseHeaders,
} from "h3";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { db } from "../../../../db";
import { recordAudit } from "../../../../utils/domain/audit";
import { packageZipStream } from "../../../../utils/export/package/build";
import {
  attachmentDisposition,
  packageFilterAudit,
  resolvePackageRequest,
} from "../../../../utils/export/package/http";
import {
  packageDownload,
  packagePartDownload,
} from "../../../../utils/export/package/service";

/**
 * Streams the documentation package (`?locale=es&editable=1`): the current
 * one, or while it is being built an earlier one whose content is all still
 * public. With `&filter=` (a part asked for before), the part, zipped from
 * the pieces as it goes out. 409 while there is none. Recorded as
 * `export.download`.
 */
export default defineEventHandler(async (event) => {
  const request = await resolvePackageRequest(event);
  const notReady = () =>
    createError({
      statusCode: 409,
      data: { messageKey: "assembly.package.notReady" },
      message: "La documentación todavía se está preparando",
    });
  const audit = () =>
    recordAudit(db, {
      event,
      actor: request.actor,
      action: AUDIT_ACTIONS.EXPORT_DOWNLOAD,
      targetType: "assembly",
      targetId: request.assemblyId,
      assemblyId: request.assemblyId,
      after: {
        package: true,
        locale: request.locale,
        editable: request.format.editable,
        justified: request.format.justified,
        part: packageFilterAudit(request.filter),
      },
    });

  if (request.filter) {
    const part = await packagePartDownload(
      request.assemblyId,
      request.locale,
      request.format,
      request.filter,
    );
    if (!part) throw notReady();
    await audit();
    setResponseHeaders(event, {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentDisposition(part.filename),
      "Cache-Control": "private, no-store",
    });
    return sendStream(
      event,
      packageZipStream(request.assemblyId, part.entries) as Readable,
    );
  }

  const file = await packageDownload(
    request.assemblyId,
    request.locale,
    request.format,
  );
  if (!file) throw notReady();
  await audit();
  setResponseHeaders(event, {
    "Content-Type": "application/zip",
    "Content-Length": String(file.bytes),
    "Content-Disposition": attachmentDisposition(file.filename),
    "Cache-Control": "private, no-store",
  });
  return sendStream(event, createReadStream(file.path));
});

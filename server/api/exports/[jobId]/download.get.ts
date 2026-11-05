import {
  defineEventHandler,
  createError,
  setResponseHeaders,
  sendStream,
} from "h3";
import { createReadStream } from "node:fs";
import { getAuthUserWithRole } from "../../../utils/auth/requireAuth";
import { hasPermission } from "../../../utils/auth/rbac";
import { recordExportDownload } from "../../../utils/export/audit";
import {
  assertExportFileExists,
  getExportPermissionForQueue,
  readExportMetadata,
  validateExportJobId,
} from "../../../utils/export/storage";

/**
 * Streams a finished export to its requester or to whoever manages its
 * queue. Every download is recorded (`export.download`) before the file
 * goes out, since the PDF may hold drafts.
 */
export default defineEventHandler(async (event) => {
  const user = await getAuthUserWithRole(event);
  const jobId = validateExportJobId(event.context.params?.jobId);
  const metadata = await readExportMetadata(jobId);

  const canRead =
    metadata.requestedBy === user?.id ||
    (await hasPermission(
      event,
      getExportPermissionForQueue(metadata.queueName),
    ));

  if (!canRead) {
    throw createError({ statusCode: 403, message: "Acceso denegado" });
  }

  if (metadata.status !== "done") {
    throw createError({
      statusCode: 409,
      message: "PDF no disponible. La exportación puede no haber finalizado.",
    });
  }

  await assertExportFileExists(metadata);
  await recordExportDownload(event, metadata);

  setResponseHeaders(event, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${metadata.filename}"`,
  });

  return sendStream(event, createReadStream(metadata.filePath));
});

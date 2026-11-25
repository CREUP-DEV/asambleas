import { sendReadStream } from "../../../utils/core/http";
import {
  defineEventHandler,
  createError,
  getRouterParam,
  setResponseHeaders,
} from "h3";
import { createReadStream } from "node:fs";
import { requireActor } from "../../../utils/domain/actor";
import { recordExportDownload } from "../../../utils/export/audit";
import {
  assertExportFileExists,
  readExportMetadata,
  requireExportReader,
  validateExportJobId,
} from "../../../utils/export/storage";

/**
 * Streams a finished export to its requester or to whoever manages its
 * queue. Every download is recorded (`export.download`) before the file
 * goes out, since the PDF may hold drafts.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const jobId = validateExportJobId(getRouterParam(event, "jobId"));
  const metadata = await readExportMetadata(jobId);
  requireExportReader(actor, metadata);

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

  return sendReadStream(event, createReadStream(metadata.filePath));
});

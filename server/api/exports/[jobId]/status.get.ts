import { defineEventHandler, createError, getRouterParam } from "h3";
import { requireActor } from "../../../utils/domain/actor";
import { getExportQueue } from "../../../utils/export/queue";
import {
  patchExportMetadata,
  readExportMetadata,
  requireExportReader,
  validateExportJobId,
} from "../../../utils/export/storage";

/**
 * The state of an export, for its requester or whoever manages its queue
 * (requireExportReader). A job the queue lost while queued is marked
 * failed.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const jobId = validateExportJobId(getRouterParam(event, "jobId"));
  const metadata = await readExportMetadata(jobId);
  requireExportReader(actor, metadata);

  try {
    if (metadata.status === "done" || metadata.status === "failed") {
      return { jobId, status: metadata.status };
    }

    const boss = await getExportQueue();
    const job = await boss.getJobById(metadata.queueName, jobId);

    if (!job) {
      if (metadata.status === "queued") {
        await patchExportMetadata(jobId, {
          status: "failed",
          error: "Job not found in queue",
        });
        return { jobId, status: "failed" };
      }
      return { jobId, status: metadata.status };
    }

    let status: "pending" | "processing" | "done" | "failed";

    switch (job.state) {
      case "completed":
        status = "done";
        break;
      case "failed":
      case "cancelled":
        status = "failed";
        break;
      case "active":
        status = "processing";
        break;
      default:
        status = metadata.status === "processing" ? "processing" : "pending";
    }

    return { jobId, status };
  } catch (error: unknown) {
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw createError({
      statusCode: 500,
      message: "Error consultando estado de exportación",
    });
  }
});

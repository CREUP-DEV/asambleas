import { defineEventHandler, createError } from "h3";
import { getAuthUserWithRole } from "../../../utils/auth/requireAuth";
import { hasPermission } from "../../../utils/auth/rbac";
import { getExportQueue } from "../../../utils/export/queue";
import {
  getExportPermissionForQueue,
  readExportMetadata,
  validateExportJobId,
} from "../../../utils/export/storage";

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

  try {
    if (metadata.status === "done" || metadata.status === "failed") {
      return { jobId, status: metadata.status };
    }

    const boss = await getExportQueue();
    const job = await boss.getJobById(metadata.queueName, jobId);

    if (!job) {
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

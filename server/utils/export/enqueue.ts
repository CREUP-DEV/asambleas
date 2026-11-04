import { randomUUID } from "node:crypto";
import { createError } from "h3";
import { logError } from "../core/logger";
import {
  getExportQueue,
  type AssemblyExportJobData,
  type DocumentExportJobData,
  type EXPORT_QUEUE_NAMES,
} from "./queue";
import {
  buildExportFilename,
  deleteExportMetadata,
  getExportPdfPath,
  writeExportMetadata,
} from "./storage";

type ExportRequest =
  | {
      queueName: typeof EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT;
      data: AssemblyExportJobData;
    }
  | {
      queueName: typeof EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT;
      data: DocumentExportJobData;
    };

/**
 * Writes the export metadata (owner, file name, status) and queues the job
 * under the same id. Metadata goes first so the worker always finds it; it
 * is removed again if the job cannot be queued.
 */
export async function enqueueExport(
  request: ExportRequest & { filenameParts: string[] },
): Promise<{ jobId: string }> {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const data = request.data;

  try {
    const boss = await getExportQueue();
    await writeExportMetadata({
      jobId,
      queueName: request.queueName,
      requestedBy: data.requestedBy,
      assemblyId: data.assemblyId,
      ...("documentId" in data
        ? { documentId: data.documentId, variant: data.variant }
        : {}),
      locale: data.locale,
      status: "queued",
      filename: buildExportFilename(request.filenameParts.filter(Boolean)),
      filePath: getExportPdfPath(jobId),
      createdAt: now,
      updatedAt: now,
    });

    const queuedId = await boss
      .send(request.queueName, data, { id: jobId })
      .catch((error: unknown) => {
        logError("export.enqueue", error);
        return null;
      });
    if (queuedId) return { jobId };

    await deleteExportMetadata(jobId);
  } catch (error) {
    logError("export.enqueue", error);
    await deleteExportMetadata(jobId);
  }

  throw createError({
    statusCode: 503,
    message: "No se pudo iniciar la exportación",
  });
}

import { randomUUID } from "node:crypto";
import type { H3Event } from "h3";
import { createError } from "h3";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { db } from "../../db";
import { logError } from "../core/logger";
import { recordAudit } from "../domain/audit";
import { exportAuditTarget } from "./audit";
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
      data: Omit<AssemblyExportJobData, "impersonationId">;
    }
  | {
      queueName: typeof EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT;
      data: Omit<DocumentExportJobData, "impersonationId">;
    };

/** Thrown inside the transaction when pg-boss does not take the job. */
class ExportNotQueuedError extends Error {}

/**
 * Writes the export metadata (owner, file name, status) and queues the job
 * under the same id. Metadata goes first so the worker always finds it; it
 * is removed again if the job cannot be queued.
 *
 * The request is recorded as `export.request` (actor and impersonation from
 * `actor`, IP and user agent from `event`) in a transaction around the
 * queuing: a job that cannot be queued leaves no row, and a row that cannot
 * be written queues no job. The impersonation also goes into the job data
 * and the metadata.
 */
export async function enqueueExport(
  request: ExportRequest & {
    filenameParts: string[];
    event: H3Event;
    /** The requester: requireActor's Actor (`data.requestedBy` is its user). */
    actor: { user: { id: string }; impersonation?: { id: string } | null };
  },
): Promise<{ jobId: string }> {
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const impersonationId = request.actor.impersonation?.id ?? null;
  const data = { ...request.data, impersonationId };
  const documentFields =
    "documentId" in request.data
      ? { documentId: request.data.documentId, variant: request.data.variant }
      : {};

  try {
    await db.transaction(async (tx) => {
      await recordAudit(tx, {
        event: request.event,
        actor: request.actor,
        action: AUDIT_ACTIONS.EXPORT_REQUEST,
        ...exportAuditTarget(data),
        assemblyId: data.assemblyId,
        after: {
          jobId,
          documentId: null,
          variant: null,
          ...documentFields,
          locale: data.locale,
        },
      });

      const boss = await getExportQueue();
      await writeExportMetadata({
        jobId,
        queueName: request.queueName,
        requestedBy: data.requestedBy,
        impersonationId,
        assemblyId: data.assemblyId,
        ...documentFields,
        locale: data.locale,
        status: "queued",
        filename: buildExportFilename(request.filenameParts.filter(Boolean)),
        filePath: getExportPdfPath(jobId),
        createdAt: now,
        updatedAt: now,
      });

      const queuedId = await boss.send(request.queueName, data, {
        id: jobId,
      });
      if (!queuedId) throw new ExportNotQueuedError("Job not queued");
    });
    return { jobId };
  } catch (error) {
    logError("export.enqueue", error);
    await deleteExportMetadata(jobId);
  }

  throw createError({
    statusCode: 503,
    message: "No se pudo iniciar la exportación",
  });
}

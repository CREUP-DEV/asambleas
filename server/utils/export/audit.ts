import type { H3Event } from "h3";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { db } from "../../db";
import { recordAudit } from "../domain/audit";
import type { ExportMetadata } from "./storage";

/**
 * What an export audit row is about: the document of a document export,
 * otherwise the assembly of the dossier.
 */
export function exportAuditTarget(data: {
  assemblyId: string;
  documentId?: string | null;
}): { targetType: "document" | "assembly"; targetId: string } {
  return data.documentId
    ? { targetType: "document", targetId: data.documentId }
    : { targetType: "assembly", targetId: data.assemblyId };
}

/**
 * `export.download`: someone downloaded a finished export (it may hold
 * drafts). The actor comes from the request (getAuthUserWithRole ran), and
 * `requestedBy` says whose export it was.
 */
export async function recordExportDownload(
  event: H3Event,
  metadata: Pick<
    ExportMetadata,
    "jobId" | "assemblyId" | "documentId" | "variant" | "requestedBy"
  >,
): Promise<void> {
  await recordAudit(db, {
    event,
    action: AUDIT_ACTIONS.EXPORT_DOWNLOAD,
    ...exportAuditTarget(metadata),
    assemblyId: metadata.assemblyId,
    after: {
      jobId: metadata.jobId,
      variant: metadata.variant ?? null,
      requestedBy: metadata.requestedBy,
    },
  });
}

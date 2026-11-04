import type {
  DocumentFormat,
  DocumentStatus,
} from "~~/shared/constants/domain";
import { canManageDocuments, type Actor } from "../domain/actor";
import type { CleanSource } from "./pdfBuilder";

/**
 * Which text an export uses. Shared by the endpoints (to answer with a
 * precise error before queueing) and the worker (which checks again with
 * the data as it is when the PDF is generated).
 */

export interface ExportableDocument {
  format: DocumentFormat;
  status: DocumentStatus;
  proponentMemberId: string | null;
  workingVersionId: string | null;
  baseVersionId: string | null;
  consolidatedVersionId: string | null;
}

/**
 * An unpublished working draft is only exported by managers, so drafts do
 * not circulate as PDFs before Secretaría publishes them. Proponents read
 * their draft in the app.
 */
export function canExportWorkingDraft(actor: Actor): boolean {
  return canManageDocuments(actor);
}

/** Consolidated text if stored, else the published base, else the working draft. */
export function pickCleanVersion(
  actor: Actor,
  document: ExportableDocument,
): { source: CleanSource; versionId: string } | null {
  if (document.consolidatedVersionId) {
    return {
      source: "consolidated",
      versionId: document.consolidatedVersionId,
    };
  }
  if (document.baseVersionId) {
    return { source: "base", versionId: document.baseVersionId };
  }
  if (document.workingVersionId && canExportWorkingDraft(actor)) {
    return { source: "working", versionId: document.workingVersionId };
  }
  return null;
}

export type ExportRefusal =
  "file_format" | "no_base" | "draft_only" | "no_text";

/** Why a document cannot be exported in the given variant, or null. */
export function exportRefusal(
  actor: Actor,
  document: ExportableDocument,
  variant: "clean" | "annotated",
): ExportRefusal | null {
  if (document.format === "file") return "file_format";
  if (variant === "annotated") return document.baseVersionId ? null : "no_base";
  if (pickCleanVersion(actor, document)) return null;
  return document.workingVersionId ? "draft_only" : "no_text";
}

/** HTTP status of each refusal. */
export const EXPORT_REFUSAL_STATUS: Record<ExportRefusal, number> = {
  file_format: 400,
  no_base: 409,
  draft_only: 403,
  no_text: 409,
};

/** Spanish API messages for each refusal (the client maps the status code). */
export const EXPORT_REFUSAL_MESSAGES: Record<ExportRefusal, string> = {
  file_format: "Este documento es un PDF subido: descárgalo directamente",
  no_base:
    "El documento aún no está publicado, así que no tiene enmiendas que anotar",
  draft_only: "Solo Secretaría puede exportar un borrador sin publicar",
  no_text: "El documento no tiene texto que exportar",
};

/** Deterministic failure of an export job: it is marked failed and not retried. */
export class ExportRejectedError extends Error {
  override name = "ExportRejectedError";
}

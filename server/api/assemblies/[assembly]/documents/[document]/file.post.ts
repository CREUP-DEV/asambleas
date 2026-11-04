import { defineEventHandler } from "h3";
import {
  assertFileReplaceable,
  attachDocumentFile,
  PDF_MAX_BYTES,
  readUploadedFile,
  requireDocumentEditor,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";

/** Multipart `file` (PDF up to 20 MB), plus an optional `updatedAt` field. */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  // Refuse before reading a large body the actor may not upload.
  requireDocumentEditor(ctx.actor, ctx.document);
  assertFileReplaceable(ctx.document);
  const file = await readUploadedFile(
    event,
    PDF_MAX_BYTES,
    "El archivo supera el límite de 20 MB",
  );
  return attachDocumentFile(ctx, file);
});

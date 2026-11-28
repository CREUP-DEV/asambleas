import { defineEventHandler } from "h3";
import type { DocumentDto } from "~~/shared/types/api";
import {
  PDF_MAX_BYTES,
  readUploadedFile,
  resolveDocumentRoute,
} from "../../../../../../utils/domain/documents";
import {
  attachSignedDocument,
  requireDocumentSigner,
} from "../../../../../../utils/domain/documentSigning";
import { throwMutationError } from "../../../../../../utils/errors";

/**
 * A document signed, as a PDF: multipart `file` (up to 20 MB, with a
 * digital signature) and `updatedAt` of its signing. Published at once,
 * replacing the one signed before.
 */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  // Refuse before reading a large body the actor may not upload.
  requireDocumentSigner(ctx);
  const file = await readUploadedFile(
    event,
    PDF_MAX_BYTES,
    "El archivo supera el límite de 20 MB",
  );
  try {
    return await attachSignedDocument(ctx, file);
  } catch (error) {
    throwMutationError("documentSigning.sign", error, event);
  }
});

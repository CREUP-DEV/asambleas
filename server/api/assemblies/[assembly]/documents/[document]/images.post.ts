import { defineEventHandler } from "h3";
import {
  readUploadedFile,
  requireDocumentEditor,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import {
  IMAGE_MAX_BYTES,
  storeDocumentImage,
  type StoredImageDto,
} from "../../../../../utils/domain/documentImages";

/** Multipart `file` (a PNG or JPEG up to 10 MB) for the document's text. */
export default defineEventHandler(async (event): Promise<StoredImageDto> => {
  const ctx = await resolveDocumentRoute(event);
  // Refuse before reading a large body the actor may not upload.
  requireDocumentEditor(ctx.actor, ctx.document);
  const file = await readUploadedFile(
    event,
    IMAGE_MAX_BYTES,
    "La imagen supera el límite de 10 MB",
  );
  return storeDocumentImage(ctx, file);
});

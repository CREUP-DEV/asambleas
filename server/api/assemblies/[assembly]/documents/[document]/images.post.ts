import { createError, defineEventHandler, isError } from "h3";
import { DOCUMENT_IMAGE_MAX_BYTES } from "~~/shared/constants/uploads";
import {
  readUploadedFile,
  requireDocumentEditor,
  resolveDocumentRoute,
  type UploadedFile,
} from "../../../../../utils/domain/documents";
import {
  storeDocumentImage,
  type StoredImageDto,
} from "../../../../../utils/domain/documentImages";

const TOO_LARGE_MESSAGE = `La imagen supera el límite de ${DOCUMENT_IMAGE_MAX_BYTES / (1024 * 1024)} MB`;

/** Multipart `file` (a PNG or JPEG up to 10 MB) for the document's text. */
export default defineEventHandler(async (event): Promise<StoredImageDto> => {
  const ctx = await resolveDocumentRoute(event);
  // Refuse before reading a large body the actor may not upload.
  requireDocumentEditor(ctx.actor, ctx.document);
  let file: UploadedFile;
  try {
    file = await readUploadedFile(
      event,
      DOCUMENT_IMAGE_MAX_BYTES,
      TOO_LARGE_MESSAGE,
    );
  } catch (error) {
    // The editor says the limit, not the generic "too large".
    if (isError(error) && error.statusCode === 413) {
      throw createError({
        statusCode: 413,
        message: TOO_LARGE_MESSAGE,
        data: { messageKey: "common.editor.image.tooLarge" },
      });
    }
    throw error;
  }
  return storeDocumentImage(ctx, file);
});

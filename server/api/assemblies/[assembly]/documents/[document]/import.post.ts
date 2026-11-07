import { defineEventHandler } from "h3";
import type { H3Event } from "h3";
import {
  readUploadedFile,
  requireTextEditor,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { convertDocx, DOCX_MAX_BYTES } from "../../../../../utils/content/docx";
import type { DocxImportDto } from "~~/shared/types/api";

/**
 * Converts an uploaded DOCX into blocks for the editor to review. Nothing is
 * stored: the client saves the result through PUT .../content. The MIME type
 * is not trusted (browsers often send application/octet-stream); the ZIP
 * signature and the archive contents are checked instead.
 */
export default defineEventHandler(async (event): Promise<DocxImportDto> => {
  const { actor, document } = await resolveDocumentRoute(event);
  requireTextEditor(actor, document);
  const file = await readUploadedFile(
    event,
    DOCX_MAX_BYTES,
    "El archivo supera el límite de 15 MB",
  );
  return convertDocx(file.data, {
    owner: actor.user.id,
    signal: clientGoneSignal(event),
    documentTitle: document.title,
  });
});

/**
 * Aborts when the client disconnects before the response is sent, so a
 * conversion nobody waits for is skipped or stopped. It watches the response:
 * the request stream is already finished once its body has been read.
 */
function clientGoneSignal(event: H3Event): AbortSignal {
  const controller = new AbortController();
  const response = event.node.res;
  if (response.destroyed) {
    controller.abort();
  } else {
    response.once("close", () => {
      if (!response.writableFinished) controller.abort();
    });
  }
  return controller.signal;
}

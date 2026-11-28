import { defineEventHandler } from "h3";
import type { DocumentDto } from "~~/shared/types/api";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { removeSignedDocument } from "../../../../../../utils/domain/documentSigning";
import { throwMutationError } from "../../../../../../utils/errors";

/** Takes a document's signed PDF away: the generated one stands again. */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  try {
    return await removeSignedDocument(ctx);
  } catch (error) {
    throwMutationError("documentSigning.remove", error, event);
  }
});

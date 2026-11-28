import { defineEventHandler } from "h3";
import type { DocumentDto } from "~~/shared/types/api";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { prepareDocumentForSigning } from "../../../../../../utils/domain/documentSigning";
import { throwMutationError } from "../../../../../../utils/errors";

/**
 * Prepares a signed document to sign (whoever signs it: an acta's managers,
 * anything else's main presenter): its PDF with the closing, the visible
 * signature and the name of whoever signs. The one prepared before goes.
 */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  try {
    return await prepareDocumentForSigning(ctx);
  } catch (error) {
    throwMutationError("documentSigning.prepare", error, event);
  }
});

import { defineEventHandler } from "h3";
import type { DocumentDto } from "~~/shared/types/api";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { prepareActaForSigning } from "../../../../../../utils/domain/documentSigning";
import { throwMutationError } from "../../../../../../utils/errors";

/**
 * Prepares an approved acta to sign (document managers): its PDF with the
 * closing, the visible signature and the name of the Secretaría Ejecutiva.
 * The one prepared before goes.
 */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  try {
    return await prepareActaForSigning(ctx);
  } catch (error) {
    throwMutationError("documentSigning.prepare", error, event);
  }
});

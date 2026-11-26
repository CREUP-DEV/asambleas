import { defineEventHandler } from "h3";
import type { DocumentDto } from "~~/shared/types/api";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { removeSignedActa } from "../../../../../../utils/domain/documentSigning";
import { throwMutationError } from "../../../../../../utils/errors";

/** Takes an acta's signed PDF away: the generated one stands again. */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  try {
    return await removeSignedActa(ctx);
  } catch (error) {
    throwMutationError("documentSigning.remove", error, event);
  }
});

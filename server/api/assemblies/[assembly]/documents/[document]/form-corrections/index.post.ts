import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { assertImagesBelong } from "../../../../../../utils/domain/documentImages";
import { createFormCorrection } from "../../../../../../utils/domain/formCorrections";
import type { FormCorrectionsDto } from "~~/shared/types/api";
import { formCorrectionSchema } from "~~/shared/utils/schemas/document";

/**
 * A correction of form to the approved text: applied at once by the
 * Secretaría or the Mesa, proposed by a presenter for the Secretaría.
 */
export default defineEventHandler(
  async (event): Promise<FormCorrectionsDto> => {
    const ctx = await resolveDocumentRoute(event);
    const body = await readBodyWith(event, formCorrectionSchema);
    // Its images are ones stored for this document.
    await assertImagesBelong(ctx.document.id, body.blocks);
    return createFormCorrection(ctx, body);
  },
);

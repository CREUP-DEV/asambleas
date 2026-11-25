import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import { resolveDocumentRoute } from "../../../../../../../utils/domain/documents";
import { decideFormCorrection } from "../../../../../../../utils/domain/formCorrections";
import { validateCuid } from "../../../../../../../utils/validation";
import type { FormCorrectionsDto } from "~~/shared/types/api";
import { formCorrectionDecisionSchema } from "~~/shared/utils/schemas/document";

/** The Secretaría applies or rejects a presenter's correction of form. */
export default defineEventHandler(
  async (event): Promise<FormCorrectionsDto> => {
    const ctx = await resolveDocumentRoute(event);
    const body = await readBodyWith(event, formCorrectionDecisionSchema);
    return decideFormCorrection(
      ctx,
      validateCuid(getRouterParam(event, "correction"), "Corrección"),
      body,
    );
  },
);

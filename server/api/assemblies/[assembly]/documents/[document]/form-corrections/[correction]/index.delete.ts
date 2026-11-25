import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import { resolveDocumentRoute } from "../../../../../../../utils/domain/documents";
import { withdrawFormCorrection } from "../../../../../../../utils/domain/formCorrections";
import { validateCuid } from "../../../../../../../utils/validation";
import type { FormCorrectionsDto } from "~~/shared/types/api";
import { formCorrectionWithdrawSchema } from "~~/shared/utils/schemas/document";

/** Its author withdraws a correction of form still waiting. */
export default defineEventHandler(
  async (event): Promise<FormCorrectionsDto> => {
    const ctx = await resolveDocumentRoute(event);
    const body = await readBodyWith(event, formCorrectionWithdrawSchema);
    return withdrawFormCorrection(
      ctx,
      validateCuid(getRouterParam(event, "correction"), "Corrección"),
      body,
    );
  },
);

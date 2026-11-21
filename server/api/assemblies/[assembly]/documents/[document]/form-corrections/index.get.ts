import { defineEventHandler } from "h3";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { listFormCorrections } from "../../../../../../utils/domain/formCorrections";
import type { FormCorrectionsDto } from "~~/shared/types/api";

/** The corrections of form to the approved text, as the reader may read them. */
export default defineEventHandler(
  async (event): Promise<FormCorrectionsDto> => {
    const ctx = await resolveDocumentRoute(event);
    return listFormCorrections(ctx);
  },
);

import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { assertOpImagesBelong } from "../../../../../../utils/domain/documentImages";
import { createConciliation } from "../../../../../../utils/domain/formCorrections";
import type { FormCorrectionsDto } from "~~/shared/types/api";
import { conciliationSchema } from "~~/shared/utils/schemas/document";

/**
 * Conciliates a passage the final vote left pending (user's decisions of
 * 2026-11-21): applied at once with document:correct_form, proposed by a
 * presenter for the Secretaría.
 */
export default defineEventHandler(
  async (event): Promise<FormCorrectionsDto> => {
    const ctx = await resolveDocumentRoute(event);
    const body = await readBodyWith(event, conciliationSchema);
    // The images its wording inserts are ones stored for this document.
    await assertOpImagesBelong(ctx.document.id, body.ops);
    return createConciliation(ctx, body);
  },
);

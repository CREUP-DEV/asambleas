import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { undoValidationBodySchema } from "~~/shared/utils/schemas/document";
import {
  loadAmendmentContext,
  undoAmendmentValidation,
} from "../../../../../../../utils/domain/amendments";

/**
 * The Secretaría takes back the validation of an amendment, published or
 * not: it goes back to review (validationReopenBlocker).
 */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readBodyWith(event, undoValidationBodySchema, {
    empty: {},
  });
  return undoAmendmentValidation(ctx, body);
});

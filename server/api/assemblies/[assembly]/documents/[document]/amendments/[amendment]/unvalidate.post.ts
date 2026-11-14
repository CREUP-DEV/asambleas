import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { undoValidationBodySchema } from "~~/shared/utils/schemas/document";
import {
  loadAmendmentContext,
  readAmendmentBody,
  undoAmendmentValidation,
} from "../../../../../../../utils/domain/amendments";

/**
 * The Secretaría takes back the validation of an amendment, published or
 * not: it goes back to review (validationReopenBlocker).
 */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, undoValidationBodySchema);
  return undoAmendmentValidation(ctx, body);
});

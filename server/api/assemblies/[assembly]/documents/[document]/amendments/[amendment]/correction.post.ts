import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { amendmentCorrectionBodySchema } from "~~/shared/utils/schemas/document";
import {
  declareInadmissibleOnReview,
  loadAmendmentContext,
  requestAmendmentCorrection,
} from "../../../../../../../utils/domain/amendments";

/**
 * The Secretaría sends a presented amendment back to draft with a note, or,
 * when it cannot be corrected (`correctable: false`), declares it not
 * admitted with that note.
 */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const { correctable, ...body } = await readBodyWith(
    event,
    amendmentCorrectionBodySchema,
    { empty: {} },
  );
  return correctable === false
    ? declareInadmissibleOnReview(ctx, body)
    : requestAmendmentCorrection(ctx, body);
});

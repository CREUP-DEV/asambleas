import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { correctionBodySchema } from "~~/shared/utils/schemas/document";
import {
  loadAmendmentContext,
  readAmendmentBody,
  requestAmendmentCorrection,
} from "../../../../../../../utils/domain/amendments";

/** The Secretaría sends a presented amendment back to draft with a note. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, correctionBodySchema);
  return requestAmendmentCorrection(ctx, body);
});

import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { acceptanceBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  readAmendmentBody,
  recordAmendmentAcceptance,
} from "../../../../../../../utils/domain/amendments";

/** A party of a transactional accepts or rejects it, or the Mesa records its answer. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, acceptanceBodySchema);
  return recordAmendmentAcceptance(ctx, body);
});

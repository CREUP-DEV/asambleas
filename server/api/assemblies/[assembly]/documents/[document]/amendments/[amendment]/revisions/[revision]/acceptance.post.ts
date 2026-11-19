import { defineEventHandler, getRouterParam } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { acceptanceBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  answerTransactionalRevision,
  loadAmendmentContext,
  readAmendmentBody,
} from "../../../../../../../../../utils/domain/amendments";
import { validateCuid } from "../../../../../../../../../utils/validation";

/** A party answers an inclusion, or the Mesa records its answer. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const revisionId = validateCuid(getRouterParam(event, "revision"));
  const body = await readAmendmentBody(event, acceptanceBodySchema);
  return answerTransactionalRevision(ctx, revisionId, body);
});

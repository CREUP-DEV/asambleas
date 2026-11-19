import { defineEventHandler, getRouterParam } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  loadAmendmentContext,
  validateTransactionalRevision,
} from "../../../../../../../../../utils/domain/amendments";
import { validateCuid } from "../../../../../../../../../utils/validation";

/** The Secretaría validates an inclusion every party accepted: it applies. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const revisionId = validateCuid(getRouterParam(event, "revision"));
  return validateTransactionalRevision(ctx, revisionId);
});

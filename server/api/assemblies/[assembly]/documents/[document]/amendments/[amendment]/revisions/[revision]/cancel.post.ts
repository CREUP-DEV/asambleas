import { defineEventHandler, getRouterParam } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  cancelTransactionalRevision,
  loadAmendmentContext,
} from "../../../../../../../../../utils/domain/amendments";
import { validateCuid } from "../../../../../../../../../utils/validation";

/** Withdraws an inclusion still open: the transactional stays as it is. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const revisionId = validateCuid(getRouterParam(event, "revision"));
  return cancelTransactionalRevision(ctx, revisionId);
});

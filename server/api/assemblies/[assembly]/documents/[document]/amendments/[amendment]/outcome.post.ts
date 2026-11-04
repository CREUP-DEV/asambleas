import { defineEventHandler } from "h3";
import { outcomeBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  applyAmendmentOutcome,
  loadAmendmentContext,
  readAmendmentBody,
  type AmendmentOutcomeResult,
} from "../../../../../../../utils/domain/amendments";

/** Mesa outcome: approve, vote, withdraw, lapse or reopen. */
export default defineEventHandler(
  async (event): Promise<AmendmentOutcomeResult> => {
    const ctx = await loadAmendmentContext(event);
    const body = await readAmendmentBody(event, outcomeBodySchema);
    return applyAmendmentOutcome(ctx, body);
  },
);

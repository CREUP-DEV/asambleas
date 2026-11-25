import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import { outcomeBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  applyAmendmentOutcome,
  loadAmendmentContext,
  type AmendmentOutcomeResult,
} from "../../../../../../../utils/domain/amendments";
import { controlsProjection } from "../../../../../../../utils/domain/projectionControl";

/** Mesa outcome: approve, vote, withdraw, lapse or reopen. */
export default defineEventHandler(
  async (event): Promise<AmendmentOutcomeResult> => {
    const ctx = await loadAmendmentContext(event);
    const body = await readBodyWith(event, outcomeBodySchema, { empty: {} });
    return applyAmendmentOutcome(ctx, body, {
      controlsProjection: controlsProjection(event, ctx.assembly.id, ctx.actor),
    });
  },
);

import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AlternativesVoteDto } from "~~/shared/types/api";
import { alternativesVoteBodySchema } from "~~/shared/utils/schemas/vote";
import {
  decideAlternatives,
  loadAmendmentDocumentContext,
} from "../../../../../../utils/domain/amendments";
import { controlsProjection } from "../../../../../../utils/domain/projectionControl";

/**
 * The Mesa records a vote between alternatives: sets of amendments, the
 * winner's approved and the others' rejected (decideAlternatives).
 */
export default defineEventHandler(
  async (event): Promise<AlternativesVoteDto> => {
    const ctx = await loadAmendmentDocumentContext(event);
    const body = await readBodyWith(event, alternativesVoteBodySchema, {
      empty: {},
    });
    return decideAlternatives(ctx, body, {
      controlsProjection: controlsProjection(event, ctx.assembly.id, ctx.actor),
    });
  },
);

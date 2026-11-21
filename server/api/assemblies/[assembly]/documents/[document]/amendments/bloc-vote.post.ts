import { defineEventHandler } from "h3";
import type { BlocVoteDto } from "~~/shared/types/api";
import { blocVoteBodySchema } from "~~/shared/utils/schemas/vote";
import {
  decideBlocVote,
  loadAmendmentDocumentContext,
  readAmendmentBody,
} from "../../../../../../utils/domain/amendments";
import { controlsProjection } from "../../../../../../utils/domain/projectionControl";

/**
 * The Mesa votes a bloc of amendments: carried, every one approved; not
 * carried, every one rejected (decideBlocVote).
 */
export default defineEventHandler(async (event): Promise<BlocVoteDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readAmendmentBody(event, blocVoteBodySchema);
  return decideBlocVote(ctx, body, {
    controlsProjection: controlsProjection(event, ctx.assembly.id, ctx.actor),
  });
});

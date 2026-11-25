import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { ItemVoteResultDto } from "~~/shared/types/api";
import { itemVoteBodySchema } from "~~/shared/utils/schemas/vote";
import { requireActor } from "../../../../../utils/domain/actor";
import {
  recordItemVote,
  requireItemVoteRecorder,
  resolveVotableItem,
} from "../../../../../utils/domain/itemVotes";
import { controlsProjection } from "../../../../../utils/domain/projectionControl";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/**
 * Records a vote on the agenda item itself (session:moderate or
 * control_sheet:edit). recordItemVote says what is refused and when it goes
 * on screen.
 */
export default defineEventHandler(async (event): Promise<ItemVoteResultDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  // Before the item: whoever may not vote learns nothing of it.
  requireItemVoteRecorder(actor);
  const item = await resolveVotableItem(
    actor,
    assembly,
    getRouterParam(event, "item"),
  );
  const body = await readBodyWith(event, itemVoteBodySchema);
  try {
    return await recordItemVote(actor, assembly, item, body, {
      controlsProjection: controlsProjection(event, assembly.id, actor),
    });
  } catch (error) {
    throwMutationError("itemVotes.record", error, event);
  }
});

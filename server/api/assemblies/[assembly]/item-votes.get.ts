import { defineEventHandler, getRouterParam } from "h3";
import type { ItemVotesDto } from "~~/shared/types/api";
import {
  loadItemVotes,
  requireItemVoteReader,
} from "../../../utils/domain/itemVotes";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { requireViewer } from "../../../utils/domain/roomView";

/**
 * The votes on agenda items the reader gets, voided ones too, oldest first
 * (session:moderate or a control sheet key). It never answers as the room:
 * with `?view=room` the reader is the room, which may read neither, so it
 * is refused.
 */
export default defineEventHandler(async (event): Promise<ItemVotesDto> => {
  const actor = await requireViewer(event);
  requireItemVoteReader(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadItemVotes(actor, assembly);
});

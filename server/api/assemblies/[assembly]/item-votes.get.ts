import { defineEventHandler } from "h3";
import type { ItemVotesDto } from "~~/shared/types/api";
import {
  loadItemVotes,
  requireItemVoteReader,
} from "../../../utils/domain/itemVotes";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * The votes on agenda items the reader gets, voided ones too, oldest first
 * (session:moderate or a control sheet key). It never answers as the room:
 * with `?view=room` the reader is the room, which may read neither, so it
 * is refused.
 */
export default defineEventHandler(async (event): Promise<ItemVotesDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  requireItemVoteReader(actor);
  return loadItemVotes(actor, assembly);
});

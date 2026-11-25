import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { VoteDto } from "~~/shared/types/api";
import { voteUnanimityBodySchema } from "~~/shared/utils/schemas/vote";
import { requireActor } from "../../../../../utils/domain/actor";
import {
  requireItemVoteRecorder,
  setVoteUnanimity,
} from "../../../../../utils/domain/itemVotes";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/**
 * Marks an assent vote in force as unanimous, or takes it back: the Mesa on
 * an agenda item's vote or a document's final vote, the control sheet's
 * editors on an agenda item's (setVoteUnanimity).
 */
export default defineEventHandler(async (event): Promise<VoteDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  // Before the body: whoever may not change votes gets 403, not 400.
  requireItemVoteRecorder(actor);
  const body = await readBodyWith(event, voteUnanimityBodySchema);
  try {
    return await setVoteUnanimity(
      actor,
      assembly,
      getRouterParam(event, "vote"),
      body,
    );
  } catch (error) {
    throwMutationError("itemVotes.unanimity", error, event);
  }
});

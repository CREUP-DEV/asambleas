import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { VoteDto } from "~~/shared/types/api";
import { voteVoidBodySchema } from "~~/shared/utils/schemas/vote";
import {
  requireItemVoteRecorder,
  voidItemVote,
} from "../../../../utils/domain/itemVotes";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Voids a vote on an agenda item (session:moderate or control_sheet:edit);
 * it stays for the record. Other votes answer 409 (voidItemVote).
 */
export default defineEventHandler(async (event): Promise<VoteDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  // Before the body: whoever may not change votes gets 403, not 400.
  requireItemVoteRecorder(actor);
  const body = await readBodyWith(event, voteVoidBodySchema);
  try {
    return await voidItemVote(
      actor,
      assembly,
      getRouterParam(event, "vote"),
      body,
    );
  } catch (error) {
    throwMutationError("itemVotes.void", error, event);
  }
});

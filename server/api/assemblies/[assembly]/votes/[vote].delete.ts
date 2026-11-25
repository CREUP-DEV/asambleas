import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { VoteDto } from "~~/shared/types/api";
import { voteVoidBodySchema } from "~~/shared/utils/schemas/vote";
import { requireActor } from "../../../../utils/domain/actor";
import {
  requireItemVoteRecorder,
  voidItemVote,
} from "../../../../utils/domain/itemVotes";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../utils/errors";

/**
 * Voids a vote on an agenda item (session:moderate or control_sheet:edit);
 * it stays for the record. Other votes answer 409 (voidItemVote).
 */
export default defineEventHandler(async (event): Promise<VoteDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
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

import type { LiveStateDto } from "~~/shared/types/api";

/**
 * The live state carries the vote on screen with its question, which on a
 * vote on an agenda item may repeat that item's title. Like every other
 * read of such a vote (toItemVoteDto in server/utils/domain/votes.ts), it
 * goes without its question to a reader who gets the item without its
 * title, or does not get it at all. Pure, so it is unit-tested on its own;
 * ./liveState.ts asks who reads what.
 */

/**
 * The agenda item whose title decides whether the vote on screen keeps its
 * question, or null when nothing would be taken out: no vote, a vote on a
 * document or an amendment, or one without a question.
 */
export function liveVoteItemId(state: LiveStateDto): string | null {
  const vote = state.vote;
  if (!vote || vote.subjectType !== "agenda_item" || vote.question === null) {
    return null;
  }
  return vote.subjectId;
}

/**
 * The live state as a reader gets it: without the question of a point
 * vote whose item it gets without its title (`titleHidden`) or does not
 * get at all (`unlisted`). `redacted` says a question was taken out; never
 * true when it was already null.
 */
export function redactLiveVote(
  state: LiveStateDto,
  marks: {
    titleHidden: ReadonlySet<string>;
    unlisted: (itemId: string) => boolean;
  },
): { state: LiveStateDto; redacted: boolean } {
  const itemId = liveVoteItemId(state);
  if (
    itemId === null ||
    !state.vote ||
    (!marks.titleHidden.has(itemId) && !marks.unlisted(itemId))
  ) {
    return { state, redacted: false };
  }
  return {
    state: { ...state, vote: { ...state.vote, question: null } },
    redacted: true,
  };
}

import type { LiveStateDto, LiveStatePushDto } from "~~/shared/types/api";
import type { Actor } from "../domain/actor";
import { loadLiveStateDto, loadPublicItemMarks } from "../domain/assemblies";
import { loadReaderItems } from "../domain/controlSheet";
import { liveVoteItemId, redactLiveVote } from "./liveStateVote";

/**
 * The live state as one reader gets it (GET and PUT .../live-state): the
 * question of a point vote on screen goes only to a reader who gets that
 * item with its title, by the rule of the item-votes endpoints and the
 * control sheet (loadReaderItems). `state` is the one already loaded, if
 * any. The agenda is read only while a point vote with a question is on
 * screen.
 */
export async function liveStateFor(
  actor: Actor,
  assemblyId: string,
  state?: LiveStateDto,
): Promise<LiveStateDto> {
  const loaded = state ?? (await loadLiveStateDto(assemblyId));
  if (liveVoteItemId(loaded) === null) return loaded;
  const { items, titleHidden } = await loadReaderItems(actor, assemblyId);
  return redactLiveVote(loaded, {
    titleHidden,
    unlisted: (itemId) => !items.has(itemId),
  }).state;
}

/**
 * The live state every stream of the assembly is pushed (./statePush.ts):
 * as someone who sees only what is public gets it, the strictest reader,
 * by the rule of the count of a secret vote (POST .../live-tally,
 * loadPublicItemMarks). `voteQuestionRedacted` says a question was taken
 * out: clients then read it through liveStateFor instead.
 */
export async function loadPublicLiveState(
  assemblyId: string,
): Promise<LiveStatePushDto> {
  const state = await loadLiveStateDto(assemblyId);
  if (liveVoteItemId(state) === null) {
    return { state, voteQuestionRedacted: false };
  }
  const marks = await loadPublicItemMarks(assemblyId);
  const redacted = redactLiveVote(state, {
    titleHidden: marks.titleHidden,
    unlisted: (itemId) => marks.unlisted.has(itemId),
  });
  return { state: redacted.state, voteQuestionRedacted: redacted.redacted };
}

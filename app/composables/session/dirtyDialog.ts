import type { VoteInput } from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import type { ElectionInput } from "~~/shared/utils/election";
import type { VoteBallotInput } from "~~/shared/utils/rollCall";

/**
 * Whether a console dialog holds work a close would lose (E-127/M-117):
 * then it is not dismissed by Escape or a click outside, and its X and
 * «Cancelar» ask first (useDirtyDialog). Only what the Mesa entered
 * counts: the members present and the votes not cast are filled from the
 * latest headcount, so they never make a dialog dirty by themselves.
 */

/** A vote with some count entered, or a delegation's ballot marked. */
export function sessionVoteCounted(vote: VoteInput): boolean {
  return (
    (vote.inFavor ?? 0) > 0 ||
    (vote.against ?? 0) > 0 ||
    (vote.abstentions ?? 0) > 0 ||
    (vote.blank ?? 0) > 0 ||
    (vote.invalid ?? 0) > 0 ||
    (vote.ballots?.length ?? 0) > 0
  );
}

/** An election with some candidate's votes or ballots counted. */
export function sessionElectionCounted(
  election: Pick<ElectionInput, "counts" | "ballots">,
): boolean {
  return election.counts.some((value) => value > 0) || election.ballots > 0;
}

/** A vote between alternatives with some vote, ballot or abstention. */
export function sessionAlternativesCounted(input: {
  counts: readonly number[];
  abstentions: number;
  blank: number;
  invalid: number;
  ballots: readonly VoteBallotInput[];
}): boolean {
  return (
    input.counts.some((value) => value > 0) ||
    input.abstentions + input.blank + input.invalid > 0 ||
    input.ballots.length > 0
  );
}

/**
 * A passage's wording edited away from where the editor started. The editor
 * hands back blocks only after the Mesa types, and none equal to what it
 * last had, so an untouched editor still holds its seed as it was.
 */
export function sessionWordingEdited(
  seed: readonly Block[],
  edited: readonly Block[],
): boolean {
  return JSON.stringify(seed) !== JSON.stringify(edited);
}

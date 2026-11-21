/**
 * A registered vote («votación registrada por llamamiento», RFAG art. 25,
 * whose sense of vote goes to the minutes, art. 32; user's decision of
 * 2026-11-21): the Mesa calls each delegation with a vote at the latest
 * headcount (the asociados in the room, and those delegated, voted by
 * their delegate) and records what each one votes. The counts come from
 * those ballots, never typed. Only the roll call (`roll_call`) stores them:
 * a secret vote never does.
 */

/**
 * What a delegation votes: in favour, against, abstains or does not vote;
 * in a vote between alternatives, one of the options (`option`, with its
 * index) instead of in favour or against.
 */
export const ROLL_CALL_CHOICES = [
  "in_favor",
  "against",
  "abstention",
  "not_voting",
  "option",
] as const;
export type RollCallChoice = (typeof ROLL_CALL_CHOICES)[number];

/** One delegation's ballot as sent. */
export interface VoteBallotInput {
  memberId: string;
  choice: RollCallChoice;
  /** The option chosen (its index), with `choice: "option"` only. */
  option?: number | null;
}

/**
 * One delegation's ballot as recorded: the member and who voted for it
 * named as they were then, as minutes keep them.
 */
export interface VoteBallot {
  memberId: string;
  acronym: string;
  name: string;
  choice: RollCallChoice;
  option: number | null;
  /** The member in the room that voted for this one (delegated). */
  delegate: { id: string; acronym: string } | null;
}

/** A voter at the headcount: the delegation and who votes for it. */
export interface RollCallVoter {
  memberId: string;
  acronym: string;
  name: string;
  delegate: { id: string; acronym: string } | null;
}

export interface RollCallCounts {
  inFavor: number;
  against: number;
  abstentions: number;
  /** The voters who did not vote (votos no emitidos). */
  notCast: number;
  /** Each option's votes, in a vote between alternatives. */
  options: number[];
  /** Every voter called. */
  present: number;
}

/** The counts the ballots give. */
export function rollCallCounts(
  ballots: readonly Pick<VoteBallot, "choice" | "option">[],
  optionCount = 0,
): RollCallCounts {
  const counts: RollCallCounts = {
    inFavor: 0,
    against: 0,
    abstentions: 0,
    notCast: 0,
    options: Array.from({ length: optionCount }, () => 0),
    present: ballots.length,
  };
  for (const ballot of ballots) {
    if (ballot.choice === "in_favor") counts.inFavor += 1;
    else if (ballot.choice === "against") counts.against += 1;
    else if (ballot.choice === "abstention") counts.abstentions += 1;
    else if (ballot.choice === "not_voting") counts.notCast += 1;
    else if (
      ballot.option != null &&
      ballot.option >= 0 &&
      ballot.option < optionCount
    ) {
      counts.options[ballot.option]! += 1;
    }
  }
  return counts;
}

export type RollCallProblem =
  | { reason: "unknown_member"; memberId: string }
  | { reason: "repeated_member"; memberId: string }
  | { reason: "bad_choice"; memberId: string };

/**
 * The ballots of every voter, in the headcount's order: each one sent, or
 * «No vota» for a voter left out. A ballot for someone who is not a voter,
 * a repeated one, or a choice the vote does not take (an option outside a
 * vote between alternatives, in favour or against inside one) is a
 * problem instead.
 */
export function resolveRollCall(
  voters: readonly RollCallVoter[],
  ballots: readonly VoteBallotInput[],
  optionCount = 0,
): { ballots: VoteBallot[] } | { problem: RollCallProblem } {
  const byMember = new Map<string, VoteBallotInput>();
  const voterIds = new Set(voters.map((voter) => voter.memberId));
  for (const ballot of ballots) {
    if (!voterIds.has(ballot.memberId)) {
      return {
        problem: { reason: "unknown_member", memberId: ballot.memberId },
      };
    }
    if (byMember.has(ballot.memberId)) {
      return {
        problem: { reason: "repeated_member", memberId: ballot.memberId },
      };
    }
    const alternatives = optionCount > 0;
    const fits =
      ballot.choice === "abstention" || ballot.choice === "not_voting"
        ? true
        : ballot.choice === "option"
          ? alternatives &&
            ballot.option != null &&
            ballot.option >= 0 &&
            ballot.option < optionCount
          : !alternatives;
    if (!fits) {
      return { problem: { reason: "bad_choice", memberId: ballot.memberId } };
    }
    byMember.set(ballot.memberId, ballot);
  }
  return {
    ballots: voters.map((voter) => {
      const ballot = byMember.get(voter.memberId);
      return {
        memberId: voter.memberId,
        acronym: voter.acronym,
        name: voter.name,
        choice: ballot?.choice ?? "not_voting",
        option: ballot?.choice === "option" ? (ballot.option ?? null) : null,
        delegate: voter.delegate,
      };
    }),
  };
}

/**
 * The voters of a headcount, in its order: the entries with a vote, each
 * with its delegate when delegated.
 */
export function rollCallVoters(
  entries: readonly {
    member: { id: string; acronym: string; name: string };
    mark: string;
    delegate: { id: string; acronym: string } | null;
    voting: boolean;
  }[],
): RollCallVoter[] {
  return entries
    .filter((entry) => entry.voting)
    .map((entry) => ({
      memberId: entry.member.id,
      acronym: entry.member.acronym,
      name: entry.member.name,
      delegate:
        entry.mark === "delegated" && entry.delegate
          ? { id: entry.delegate.id, acronym: entry.delegate.acronym }
          : null,
    }));
}

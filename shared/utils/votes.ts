import type {
  AssemblySettings,
  Majority,
  VoteMethod,
  VoteResult,
} from "../constants/domain";

/**
 * The counts of a vote (user's decision of 2026-11-19): in favour, against
 * and abstentions in a vote by show of hands, roll call or the portal; in
 * favour, against, blank and invalid in a secret one, where a blank ballot
 * is how a voter abstains. `notCast` are the members present who cast
 * nothing, in any method.
 */
export interface VoteCounts {
  inFavor: number;
  against: number;
  abstentions: number;
  blank?: number;
  invalid?: number;
  /** Members present who cast nothing (votos no emitidos). */
  notCast?: number;
  /** Members present with vote; required when the denominator is "present". */
  present?: number | null;
}

/** What a voter may cast: every count but those who cast nothing. */
export type BallotKey =
  "inFavor" | "against" | "abstentions" | "blank" | "invalid";

/** Blank and invalid ballots only exist in a secret vote. */
export const SECRET_BALLOT_KEYS = [
  "inFavor",
  "against",
  "blank",
  "invalid",
] as const satisfies readonly BallotKey[];
/** A vote by show of hands, roll call or the portal: no blank, no invalid. */
export const OPEN_BALLOT_KEYS = [
  "inFavor",
  "against",
  "abstentions",
] as const satisfies readonly BallotKey[];

/** The ballots a method takes; assent takes none. */
export function ballotKeysOf(method: VoteMethod): readonly BallotKey[] {
  if (method === "assent") return [];
  return method === "secret" ? SECRET_BALLOT_KEYS : OPEN_BALLOT_KEYS;
}

/** The counts a method does not take, which must stay at zero. */
export function foreignBallotKeys(method: VoteMethod): BallotKey[] {
  if (method === "assent") return [];
  const own = new Set<BallotKey>(ballotKeysOf(method));
  return (
    ["inFavor", "against", "abstentions", "blank", "invalid"] as const
  ).filter((key) => !own.has(key));
}

/** Every ballot cast: in favour, against, abstentions, blank and invalid. */
export function ballotsCast(
  counts: Pick<VoteCounts, "inFavor" | "against" | "abstentions"> &
    Partial<Pick<VoteCounts, "blank" | "invalid">>,
): number {
  return (
    counts.inFavor +
    counts.against +
    counts.abstentions +
    (counts.blank ?? 0) +
    (counts.invalid ?? 0)
  );
}

/** The members present who cast nothing: null without a base. */
export function notCastOf(
  present: number | null | undefined,
  cast: number,
): number | null {
  return present == null ? null : Math.max(0, present - cast);
}

/**
 * The counts to show, in order: in favour, against, then abstentions (a
 * secret vote: blank), invalid ballots and those who cast nothing only when
 * there were any. A count the method does not take shows only if a vote
 * stores one.
 */
export function shownVoteCounts(
  vote: Pick<VoteCounts, "inFavor" | "against" | "abstentions"> &
    Partial<Pick<VoteCounts, "blank" | "invalid" | "notCast">> & {
      method: VoteMethod;
    },
): { key: BallotKey | "notCast"; value: number }[] {
  const secret = vote.method === "secret";
  const rows: { key: BallotKey | "notCast"; value: number }[] = [
    { key: "inFavor", value: vote.inFavor },
    { key: "against", value: vote.against },
  ];
  const abstentions = vote.abstentions;
  const blank = vote.blank ?? 0;
  if (secret) {
    rows.push({ key: "blank", value: blank });
    if (abstentions > 0) rows.push({ key: "abstentions", value: abstentions });
  } else {
    rows.push({ key: "abstentions", value: abstentions });
    if (blank > 0) rows.push({ key: "blank", value: blank });
  }
  if ((vote.invalid ?? 0) > 0) {
    rows.push({ key: "invalid", value: vote.invalid ?? 0 });
  }
  if ((vote.notCast ?? 0) > 0) {
    rows.push({ key: "notCast", value: vote.notCast ?? 0 });
  }
  return rows;
}

/**
 * The i18n key of a one-line count text: `base` («A favor 10 · En contra 2
 * · Abstenciones 3») or its `Secret` twin, which names the blank ballots
 * instead. Both take inFavor, against, abstentions and blank.
 */
export function voteTextKey(base: string, method: VoteMethod): string {
  return method === "secret" ? `${base}Secret` : base;
}

/**
 * The third figure of a short «favor / contra / x» line: abstentions, or
 * the blank ballots of a secret vote.
 */
export function thirdCount(
  vote: Pick<VoteCounts, "abstentions"> &
    Partial<Pick<VoteCounts, "blank">> & { method: VoteMethod },
): number {
  return vote.method === "secret" ? (vote.blank ?? 0) : vote.abstentions;
}

export interface VoteOutcome {
  result: VoteResult | "tie";
  /** Votes needed to approve under the chosen majority and denominator. */
  threshold: number;
  denominator: number;
  /** Counts that do not add up (more votes than present members). */
  inconsistent: boolean;
}

/**
 * Votes in favour needed under an absolute (more than half) or two-thirds
 * (at least two thirds) majority of `denominator`. A simple majority has no
 * fixed figure: more in favour than against.
 */
export function majorityThreshold(
  majority: Exclude<Majority, "simple">,
  denominator: number,
): number {
  return majority === "absolute"
    ? Math.floor(denominator / 2) + 1
    : Math.ceil((denominator * 2) / 3);
}

/**
 * Computes the result of a vote.
 * - simple: more in favor than against;
 * - absolute: more than half of the denominator;
 * - two_thirds: at least two thirds of the denominator.
 * The denominator is the valid votes cast (in favor + against + abstentions
 * + blank: invalid ballots and those who cast nothing are out; user's
 * decision of 2026-11-19) or the members present, depending on the
 * assembly settings.
 */
export function computeVoteOutcome(
  counts: VoteCounts,
  majority: Majority,
  settings: Pick<AssemblySettings, "denominator" | "tieRule">,
): VoteOutcome {
  const valid =
    counts.inFavor + counts.against + counts.abstentions + (counts.blank ?? 0);
  const cast = valid + (counts.invalid ?? 0);
  const usePresent =
    settings.denominator === "present" && counts.present != null;
  const denominator = usePresent ? counts.present! : valid;
  const inconsistent = counts.present != null && cast > counts.present;

  if (majority === "simple") {
    const threshold = counts.against + 1;
    if (counts.inFavor === counts.against) {
      return {
        result: settings.tieRule === "repeat" ? "tie" : "rejected",
        threshold,
        denominator,
        inconsistent,
      };
    }
    return {
      result: counts.inFavor > counts.against ? "approved" : "rejected",
      threshold,
      denominator,
      inconsistent,
    };
  }

  const threshold = majorityThreshold(majority, denominator);
  return {
    result:
      denominator > 0 && counts.inFavor >= threshold ? "approved" : "rejected",
    threshold,
    denominator,
    inconsistent,
  };
}

import type {
  AssemblySettings,
  Majority,
  VoteResult,
} from "../constants/domain";

export interface VoteCounts {
  inFavor: number;
  against: number;
  abstentions: number;
  blank?: number;
  invalid?: number;
  /** Members present with vote; required when the denominator is "present". */
  present?: number | null;
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
 * The denominator is the valid votes cast (in favor + against + abstentions)
 * or the members present, depending on the assembly settings.
 */
export function computeVoteOutcome(
  counts: VoteCounts,
  majority: Majority,
  settings: Pick<AssemblySettings, "denominator" | "tieRule">,
): VoteOutcome {
  const valid = counts.inFavor + counts.against + counts.abstentions;
  const cast = valid + (counts.blank ?? 0) + (counts.invalid ?? 0);
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

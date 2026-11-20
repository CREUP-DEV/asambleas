import type { AssemblySettings, Majority } from "../constants/domain";
import { majorityThreshold } from "./votes";

/**
 * A vote between alternatives (user's decisions of 2026-11-20): the room
 * chooses between sets of amendments («Opción A», «Opción B»…) or abstains.
 * The option with most votes wins: its amendments are approved and those of
 * the others rejected. Where the document's amendments need an absolute or
 * two-thirds majority (a reform of the Estatutos or a regulation, RRI art.
 * 65.5), the winner must reach it too. On a tie at the top, or a winner
 * short of that majority, the Mesa chooses: reject them all, repeat the
 * vote, or leave them undecided (`AlternativesTieResolution`).
 */

/** How many options a vote between alternatives has, for now. */
export const ALTERNATIVES_OPTION_COUNT = 2;

/** What the Mesa does when no option wins. Repeating records nothing. */
/**
 * What the winning option's amendments become (user's decision of
 * 2026-11-21): approved (`approve`, the default), or left undecided
 * (`keep`), only the other options' rejected, so the winner is voted next
 * against the original text, as the 80.ª AGO did.
 */
export const ALTERNATIVES_WINNER_OUTCOMES = ["approve", "keep"] as const;
export type AlternativesWinnerOutcome =
  (typeof ALTERNATIVES_WINNER_OUTCOMES)[number];

export const ALTERNATIVES_TIE_RESOLUTIONS = [
  "reject_all",
  "no_effect",
] as const;
export type AlternativesTieResolution =
  (typeof ALTERNATIVES_TIE_RESOLUTIONS)[number];

export interface AlternativesCounts {
  /** The votes each option got, in order (A, B…). */
  options: readonly number[];
  /** Show of hands, roll call and the portal. */
  abstentions: number;
  /** A secret vote only. */
  blank?: number;
  invalid?: number;
  /** Members present with vote, when known. */
  present?: number | null;
}

export interface AlternativesOutcome {
  /** The option that won (its index), or null when none did. */
  winner: number | null;
  /**
   * Why none won: a tie at the top, or a winner short of the majority the
   * document's amendments need.
   */
  undecided: "tie" | "short" | null;
  /** Votes an option needs under an absolute or two-thirds majority. */
  threshold: number | null;
  denominator: number;
  /** More votes than members present. */
  inconsistent: boolean;
}

/**
 * The result of a vote between alternatives. The denominator follows the
 * assembly (`denominator`): the valid votes (every option, abstentions and
 * blank ballots) or the members present.
 */
export function computeAlternativesOutcome(
  counts: AlternativesCounts,
  majority: Majority,
  settings: Pick<AssemblySettings, "denominator">,
): AlternativesOutcome {
  const optionVotes = counts.options.reduce((sum, value) => sum + value, 0);
  const valid = optionVotes + counts.abstentions + (counts.blank ?? 0);
  const cast = valid + (counts.invalid ?? 0);
  const denominator =
    settings.denominator === "present" && counts.present != null
      ? counts.present
      : valid;
  const inconsistent = counts.present != null && cast > counts.present;
  const top = Math.max(0, ...counts.options);
  const leaders = counts.options
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value === top);
  if (top === 0 || leaders.length !== 1) {
    return {
      winner: null,
      undecided: "tie",
      threshold: null,
      denominator,
      inconsistent,
    };
  }
  if (majority === "simple") {
    return {
      winner: leaders[0]!.index,
      undecided: null,
      threshold: null,
      denominator,
      inconsistent,
    };
  }
  const threshold = majorityThreshold(majority, denominator);
  const reached = denominator > 0 && top >= threshold;
  return {
    winner: reached ? leaders[0]!.index : null,
    undecided: reached ? null : "short",
    threshold,
    denominator,
    inconsistent,
  };
}

/**
 * Why these sets cannot be put to a vote between alternatives, or null:
 * as many options as ALTERNATIVES_OPTION_COUNT, none empty, and no
 * amendment in two of them.
 */
export function alternativesSetsProblem(
  options: readonly (readonly string[])[],
): "count" | "empty" | "overlap" | null {
  if (options.length !== ALTERNATIVES_OPTION_COUNT) return "count";
  if (options.some((ids) => ids.length === 0)) return "empty";
  const seen = new Set<string>();
  for (const ids of options) {
    for (const id of ids) {
      if (seen.has(id)) return "overlap";
      seen.add(id);
    }
  }
  return null;
}

/** «A», «B»…: how an option is named. */
export function alternativeLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

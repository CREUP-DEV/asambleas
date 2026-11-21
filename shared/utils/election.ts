import type { AssemblySettings } from "../constants/domain";
import { majorityThreshold } from "./votes";

/**
 * An election in an agenda item's vote (user's decisions of 2026-11-21):
 * candidates, the posts to fill (`posts`, the most candidates that may be
 * elected), the most candidates each ballot may mark (`maxChoices`, not
 * necessarily the posts) and the rule, set per vote because the bodies
 * differ:
 * - `absolute_runoff`: as the regulations of the CAS and the CAI, elected
 *   in the first round whoever reaches the absolute majority of the votes
 *   cast, up to the posts; the posts left go to a second round between the
 *   most voted of the rest (twice as many as posts left), by simple
 *   majority, which the Mesa holds as a new vote;
 * - `simple`: the most voted, up to the posts.
 * A tie at the last post leaves it unfilled for the Mesa to decide.
 */
export const ELECTION_RULES = ["absolute_runoff", "simple"] as const;
export type ElectionRule = (typeof ELECTION_RULES)[number];

/** The most candidates an election takes. */
export const ELECTION_MAX_CANDIDATES = 30;
export const ELECTION_CANDIDATE_MAX_LENGTH = 120;

/** An election as the Mesa records it. */
export interface ElectionInput {
  candidates: string[];
  /** Posts to fill: the most candidates that may be elected. */
  posts: number;
  /** The most candidates a ballot may mark. */
  maxChoices: number;
  rule: ElectionRule;
  /** Each candidate's votes, in order. */
  counts: number[];
  /** Ballots that marked at least one candidate. */
  ballots: number;
}

/** An election as recorded, with its result. */
export interface ElectionRecord extends ElectionInput {
  /** The candidates elected (their indexes), most voted first. */
  elected: number[];
  /** Those going to a second round; null when none is needed. */
  runoff: number[] | null;
  /** A tie at the last post left it unfilled. */
  tie: boolean;
}

export interface ElectionOutcome {
  elected: number[];
  runoff: number[] | null;
  tie: boolean;
  /** Votes a candidate needs under `absolute_runoff`; null otherwise. */
  threshold: number | null;
  denominator: number;
  /** More ballots than members present. */
  inconsistent: boolean;
}

/**
 * The result of an election. The votes cast are the ballots that marked
 * someone and the blank ones (invalid ones are out), or the members present
 * when the assembly counts majorities on them (`denominator`).
 */
export function computeElectionOutcome(
  election: Pick<ElectionInput, "counts" | "ballots" | "posts" | "rule">,
  rest: { blank: number; invalid: number; present: number | null },
  settings: Pick<AssemblySettings, "denominator">,
): ElectionOutcome {
  const cast = election.ballots + rest.blank;
  const denominator =
    settings.denominator === "present" && rest.present != null
      ? rest.present
      : cast;
  const inconsistent =
    rest.present != null && cast + rest.invalid > rest.present;
  const posts = Math.max(0, Math.min(election.posts, election.counts.length));
  const ranked = election.counts
    .map((count, index) => ({ count, index }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index);
  const threshold =
    election.rule === "absolute_runoff"
      ? majorityThreshold("absolute", denominator)
      : null;
  const qualifying =
    threshold === null
      ? ranked
      : ranked.filter((entry) => denominator > 0 && entry.count >= threshold);

  // The posts filled, leaving out a tie at the last one.
  let elected = qualifying.slice(0, posts);
  let tie = false;
  const next = qualifying[posts];
  const last = elected[elected.length - 1];
  if (last && next && next.count === last.count) {
    elected = elected.filter((entry) => entry.count > last.count);
    tie = true;
  }
  const electedIds = elected.map((entry) => entry.index);

  let runoff: number[] | null = null;
  const left = posts - electedIds.length;
  if (election.rule === "absolute_runoff" && left > 0 && !tie) {
    const rest = ranked.filter((entry) => !electedIds.includes(entry.index));
    const size = Math.max(2, left * 2);
    const cut = rest[size - 1];
    // Whoever ties with the last place of the second round goes too.
    const going = cut ? rest.filter((entry) => entry.count >= cut.count) : rest;
    runoff = going.length > 0 ? going.map((entry) => entry.index) : null;
  }
  return {
    elected: electedIds,
    runoff,
    tie,
    threshold,
    denominator,
    inconsistent,
  };
}

/**
 * An election as `votes.election` may hold it: one recorded before the
 * posts were set apart from the marks per ballot (2026-11-21) has no
 * `posts`, and then its posts were its `maxChoices`.
 */
export type StoredElectionRecord = Omit<ElectionRecord, "posts"> & {
  posts?: number;
};

/** A stored election with its posts (StoredElectionRecord). */
export function electionWithPosts(
  election: StoredElectionRecord,
): ElectionRecord {
  return { ...election, posts: election.posts ?? election.maxChoices };
}

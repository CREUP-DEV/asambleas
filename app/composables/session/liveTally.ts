import type {
  LiveTally,
  LiveTallyReveal,
  VoteInput,
} from "~~/shared/types/api";
import { VOTE_QUESTION_MAX_LENGTH } from "~~/shared/utils/schemas/vote";
import { SECRET_BALLOT_KEYS } from "~~/shared/utils/votes";

/**
 * What a vote form of the session console announces on the projection
 * while a secret vote is counted (POST .../live-tally). Pure, so it is
 * unit-tested on its own (liveTally.test.ts).
 */

/** What is voted, as the dialog that holds the form knows it. */
export interface LiveTallyAnnounce {
  subject: LiveTally["subject"];
  /** What the Mesa wrote is voted (an agenda item's vote), if anything. */
  question?: string | null;
}

/**
 * The announcement for a vote form (user's decision of 2026-11-19): only a
 * secret vote counted in the console while the session is open, and only
 * once the Mesa has picked how the room follows the count, so nothing goes
 * on screen before («Al final, con el resultado» or «En directo, papeleta a
 * papeleta»). It names what is voted and its question; the running count
 * goes only when it is shown ballot by ballot (`counts` null otherwise).
 * Null means nothing on screen.
 */
export function sessionLiveTally(
  vote: Pick<
    VoteInput,
    "method" | "inFavor" | "against" | "blank" | "invalid" | "majority"
  >,
  options: {
    /** The console's session is open (its form counts for the room). */
    counting: boolean;
    reveal: LiveTallyReveal | null;
    announce?: LiveTallyAnnounce | null;
    /** The base the Mesa counts on (the latest headcount), if known. */
    present: number | null;
  },
): LiveTally | null {
  if (!options.counting || vote.method !== "secret" || !options.reveal) {
    return null;
  }
  const question =
    options.announce?.question?.trim().slice(0, VOTE_QUESTION_MAX_LENGTH) ||
    null;
  return {
    subject: options.announce?.subject ?? null,
    question,
    method: vote.method,
    reveal: options.reveal,
    counts:
      options.reveal === "live"
        ? {
            inFavor: vote.inFavor ?? 0,
            against: vote.against ?? 0,
            blank: vote.blank ?? 0,
            invalid: vote.invalid ?? 0,
          }
        : null,
    present: options.present,
    majority: vote.majority ?? "simple",
  };
}

type SecretBallots = Pick<VoteInput, (typeof SECRET_BALLOT_KEYS)[number]>;

/**
 * A secret vote counted in the console counts nothing until the Mesa picks
 * how the room follows it, so no count it cannot see is recorded or later
 * reaches the screen all at once: its ballots back at zero. The same
 * object when they already are (the form writes only on a change).
 */
export function sessionPendingTallyVote<T extends SecretBallots>(vote: T): T {
  if (SECRET_BALLOT_KEYS.every((key) => (vote[key] ?? 0) === 0)) return vote;
  const next = { ...vote };
  for (const key of SECRET_BALLOT_KEYS) next[key] = 0;
  return next;
}

/**
 * Whether the Mesa may switch how the room follows the count: never from
 * «Al final, con el resultado» to «En directo» once ballots are entered,
 * which would put them on screen before the result. From live to the end
 * hides what was already shown, so it is always allowed.
 */
export function sessionRevealAllowed(
  from: LiveTallyReveal | null,
  to: LiveTallyReveal,
  ballots: number,
): boolean {
  return !(from === "end" && to === "live" && ballots > 0);
}

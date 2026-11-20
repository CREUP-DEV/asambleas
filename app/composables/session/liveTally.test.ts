import { describe, expect, it } from "vitest";
import type { VoteInput } from "~~/shared/types/api";
import { VOTE_QUESTION_MAX_LENGTH } from "~~/shared/utils/schemas/vote";
import {
  sessionLiveTally,
  sessionPendingTallyVote,
  sessionRevealAllowed,
} from "./liveTally";

const vote = (over: Partial<VoteInput> = {}): VoteInput => ({
  method: "secret",
  inFavor: 4,
  against: 2,
  abstentions: 0,
  blank: 1,
  invalid: 0,
  majority: "absolute",
  ...over,
});

const announce = {
  subject: { type: "agenda_item" as const, id: "item1" },
  question: "  ¿Se ratifica el nombramiento?  ",
};

describe("sessionLiveTally", () => {
  it("announces nothing until the Mesa picks how the count is shown", () => {
    expect(
      sessionLiveTally(vote(), {
        counting: true,
        reveal: null,
        announce,
        present: 30,
      }),
    ).toBeNull();
  });

  it("announces nothing outside a secret vote or an open session", () => {
    expect(
      sessionLiveTally(vote({ method: "show_of_hands" }), {
        counting: true,
        reveal: "live",
        announce,
        present: 30,
      }),
    ).toBeNull();
    expect(
      sessionLiveTally(vote(), {
        counting: false,
        reveal: "live",
        announce,
        present: 30,
      }),
    ).toBeNull();
  });

  it("sends the running count when it is shown ballot by ballot", () => {
    expect(
      sessionLiveTally(vote(), {
        counting: true,
        reveal: "live",
        announce,
        present: 30,
      }),
    ).toEqual({
      subject: { type: "agenda_item", id: "item1" },
      question: "¿Se ratifica el nombramiento?",
      method: "secret",
      reveal: "live",
      counts: { inFavor: 4, against: 2, blank: 1, invalid: 0 },
      present: 30,
      majority: "absolute",
    });
  });

  it("keeps the count off screen when the result comes at the end", () => {
    const tally = sessionLiveTally(vote(), {
      counting: true,
      reveal: "end",
      announce,
      present: null,
    });
    expect(tally?.counts).toBeNull();
    expect(tally?.reveal).toBe("end");
    expect(tally?.question).toBe("¿Se ratifica el nombramiento?");
  });

  it("goes unnamed without what is voted, and trims the question to its limit", () => {
    expect(
      sessionLiveTally(vote({ majority: undefined }), {
        counting: true,
        reveal: "end",
        present: null,
      }),
    ).toMatchObject({ subject: null, question: null, majority: "simple" });
    const long = sessionLiveTally(vote(), {
      counting: true,
      reveal: "end",
      announce: {
        subject: null,
        question: "x".repeat(VOTE_QUESTION_MAX_LENGTH + 20),
      },
      present: null,
    });
    expect(long?.question).toHaveLength(VOTE_QUESTION_MAX_LENGTH);
    expect(
      sessionLiveTally(vote(), {
        counting: true,
        reveal: "end",
        announce: { subject: null, question: "   " },
        present: null,
      })?.question,
    ).toBeNull();
  });
});

describe("sessionPendingTallyVote", () => {
  it("puts every secret ballot back at zero", () => {
    expect(
      sessionPendingTallyVote(vote({ inFavor: 12, against: 3, invalid: 1 })),
    ).toEqual(vote({ inFavor: 0, against: 0, blank: 0, invalid: 0 }));
  });

  it("returns the same vote when nothing is counted", () => {
    const empty = vote({ inFavor: 0, against: 0, blank: 0, invalid: 0 });
    expect(sessionPendingTallyVote(empty)).toBe(empty);
    const unset: VoteInput = { method: "secret" };
    expect(sessionPendingTallyVote(unset)).toBe(unset);
  });
});

describe("sessionRevealAllowed", () => {
  it("keeps typed ballots off the screen until the result", () => {
    expect(sessionRevealAllowed("end", "live", 5)).toBe(false);
    expect(sessionRevealAllowed("end", "live", 0)).toBe(true);
  });

  it("allows any other switch", () => {
    expect(sessionRevealAllowed(null, "live", 5)).toBe(true);
    expect(sessionRevealAllowed(null, "end", 5)).toBe(true);
    expect(sessionRevealAllowed("live", "end", 5)).toBe(true);
    expect(sessionRevealAllowed("end", "end", 5)).toBe(true);
  });
});

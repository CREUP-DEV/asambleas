import { describe, expect, it } from "vitest";
import type { LiveTally, VoteInput } from "~~/shared/types/api";
import { VOTE_QUESTION_MAX_LENGTH } from "~~/shared/utils/schemas/vote";
import {
  latestTallySender,
  sessionElectionTally,
  sessionLiveTally,
  sessionPendingTallyVote,
  sessionRevealAllowed,
  sessionTallyRepeatDue,
} from "./liveTally";

/** A count told apart by its votes in favour. */
const count = (inFavor: number) =>
  ({ counts: { inFavor } }) as unknown as LiveTally;

/** A fake POST that stays in flight until `finish` is called. */
function fakePost() {
  const sent: (number | null)[] = [];
  const pending: (() => void)[] = [];
  const send = (tally: LiveTally | null) => {
    sent.push(tally ? (tally.counts?.inFavor ?? -1) : null);
    return new Promise<void>((resolve) => pending.push(resolve));
  };
  const finish = async () => {
    pending.shift()?.();
    // Let the sender's loop pick up what waits.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return { sent, send, finish };
}

describe("latestTallySender", () => {
  it("sends at once when nothing is in flight", () => {
    const post = fakePost();
    const push = latestTallySender(post.send);
    push(count(1));
    expect(post.sent).toEqual([1]);
  });

  it("drops the counts superseded while a POST was in flight", async () => {
    const post = fakePost();
    const push = latestTallySender(post.send);
    push(count(1));
    push(count(2));
    push(count(3));
    push(count(4));
    expect(post.sent).toEqual([1]);
    await post.finish();
    expect(post.sent).toEqual([1, 4]);
    await post.finish();
    expect(post.sent).toEqual([1, 4]);
  });

  it("sends the null behind the POST in flight, never before it", async () => {
    const post = fakePost();
    const push = latestTallySender(post.send);
    push(count(1));
    push(null);
    expect(post.sent).toEqual([1]);
    await post.finish();
    expect(post.sent).toEqual([1, null]);
  });

  it("lets a null replace a count still waiting", async () => {
    const post = fakePost();
    const push = latestTallySender(post.send);
    push(count(1));
    push(count(2));
    push(null);
    await post.finish();
    expect(post.sent).toEqual([1, null]);
  });

  it("sends a new count after a null, and goes on after a failure", async () => {
    const sent: (LiveTally | null)[] = [];
    let fail = true;
    const push = latestTallySender(async (tally) => {
      sent.push(tally);
      if (fail) throw new Error("offline");
    });
    push(null);
    await Promise.resolve();
    await Promise.resolve();
    fail = false;
    push(count(5));
    await Promise.resolve();
    expect(sent).toEqual([null, count(5)]);
  });
});

describe("sessionTallyRepeatDue", () => {
  it("repeats while nothing is being saved", () => {
    expect(sessionTallyRepeatDue({ busy: false, skippedLast: false })).toBe(
      true,
    );
  });

  it("skips one repeat while the console saves", () => {
    expect(sessionTallyRepeatDue({ busy: true, skippedLast: false })).toBe(
      false,
    );
  });

  it("never skips two in a row", () => {
    expect(sessionTallyRepeatDue({ busy: true, skippedLast: true })).toBe(true);
  });
});

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

describe("sessionElectionTally (an election counted on screen)", () => {
  const election = {
    candidates: [" EL VALOR DE ESTAR UNIDOS ", ""],
    counts: [7, 2],
    ballots: 9,
    posts: 1,
    maxChoices: 1,
    rule: "absolute_runoff" as const,
  };
  const secret = { method: "secret" as const, blank: 1, invalid: 2 };
  const options = {
    counting: true,
    projected: true,
    announce: {
      subject: { type: "agenda_item" as const, id: "i1" },
      question: "22. Elección",
    },
    present: 30,
  };

  it("carries each candidate's votes, the blank and the invalid ones", () => {
    expect(sessionElectionTally(election, secret, options)).toEqual({
      subject: { type: "agenda_item", id: "i1" },
      question: "22. Elección",
      method: "secret",
      reveal: "live",
      counts: { inFavor: 0, against: 0, blank: 1, invalid: 2 },
      election: {
        candidates: ["EL VALOR DE ESTAR UNIDOS", ""],
        counts: [7, 2],
        ballots: null,
        posts: 1,
        maxChoices: 1,
        rule: "absolute_runoff",
      },
      present: 30,
      majority: "simple",
    });
  });

  it("carries the ballots when one may mark several", () => {
    expect(
      sessionElectionTally({ ...election, maxChoices: 2 }, secret, options)
        ?.election?.ballots,
    ).toBe(9);
  });

  it("goes on screen by show of hands too", () => {
    expect(
      sessionElectionTally(
        election,
        { method: "show_of_hands", blank: 0, invalid: 0 },
        options,
      )?.method,
    ).toBe("show_of_hands");
  });

  it("puts nothing on screen while the switch is off or out of session", () => {
    expect(
      sessionElectionTally(election, secret, { ...options, projected: false }),
    ).toBeNull();
    expect(
      sessionElectionTally(election, secret, { ...options, counting: false }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { Block } from "~~/shared/types/content";
import {
  sessionAlternativesCounted,
  sessionElectionCounted,
  sessionVoteCounted,
  sessionWordingEdited,
} from "./dirtyDialog";
import { sessionEmptyVote } from "./sessionModel";

describe("sessionVoteCounted", () => {
  it("is false for an empty vote, even with the headcount's present and not cast", () => {
    expect(sessionVoteCounted(sessionEmptyVote("simple"))).toBe(false);
    expect(
      sessionVoteCounted({
        ...sessionEmptyVote("absolute", 40),
        notCast: 40,
      }),
    ).toBe(false);
  });

  it("is true once any count is entered", () => {
    for (const key of [
      "inFavor",
      "against",
      "abstentions",
      "blank",
      "invalid",
    ] as const) {
      expect(
        sessionVoteCounted({ ...sessionEmptyVote("simple"), [key]: 1 }),
      ).toBe(true);
    }
  });

  it("is true once a delegation's ballot is marked in a roll call", () => {
    expect(
      sessionVoteCounted({
        ...sessionEmptyVote("simple"),
        method: "roll_call",
        ballots: [{ memberId: "m1", choice: "in_favor" }],
      }),
    ).toBe(true);
    expect(
      sessionVoteCounted({
        ...sessionEmptyVote("simple"),
        method: "roll_call",
        ballots: [],
      }),
    ).toBe(false);
  });
});

describe("sessionElectionCounted", () => {
  it("is false with no votes nor ballots", () => {
    expect(sessionElectionCounted({ counts: [0, 0], ballots: 0 })).toBe(false);
  });

  it("is true with a candidate's votes or ballots counted", () => {
    expect(sessionElectionCounted({ counts: [0, 2], ballots: 0 })).toBe(true);
    expect(sessionElectionCounted({ counts: [0, 0], ballots: 3 })).toBe(true);
  });
});

describe("sessionAlternativesCounted", () => {
  const empty = {
    counts: [0, 0],
    abstentions: 0,
    blank: 0,
    invalid: 0,
    ballots: [],
  };

  it("is false before anything is counted", () => {
    expect(sessionAlternativesCounted(empty)).toBe(false);
  });

  it("is true with an option's votes, an abstention, a blank or invalid ballot", () => {
    expect(sessionAlternativesCounted({ ...empty, counts: [0, 1] })).toBe(true);
    expect(sessionAlternativesCounted({ ...empty, abstentions: 1 })).toBe(true);
    expect(sessionAlternativesCounted({ ...empty, blank: 1 })).toBe(true);
    expect(sessionAlternativesCounted({ ...empty, invalid: 1 })).toBe(true);
  });

  it("is true with a roll call under way", () => {
    expect(
      sessionAlternativesCounted({
        ...empty,
        ballots: [{ memberId: "m1", choice: "option", option: 0 }],
      }),
    ).toBe(true);
  });
});

describe("sessionWordingEdited", () => {
  const p = (id: string, text: string): Block => ({
    id,
    type: "paragraph",
    text,
    marks: [],
  });
  const seed = [p("b1", "Artículo 1."), p("b2", "Texto.")];

  it("is false for the seed itself or a copy of it", () => {
    expect(sessionWordingEdited(seed, seed)).toBe(false);
    expect(sessionWordingEdited(seed, structuredClone(seed))).toBe(false);
    expect(sessionWordingEdited([], [])).toBe(false);
  });

  it("is true once the text, a block or the order changes", () => {
    expect(
      sessionWordingEdited(seed, [seed[0]!, p("b2", "Texto cambiado.")]),
    ).toBe(true);
    expect(sessionWordingEdited(seed, [seed[0]!])).toBe(true);
    expect(sessionWordingEdited(seed, [seed[1]!, seed[0]!])).toBe(true);
  });
});

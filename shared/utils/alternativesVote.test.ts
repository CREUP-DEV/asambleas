import { describe, expect, it } from "vitest";
import {
  alternativeLetter,
  alternativesSetsProblem,
  computeAlternativesOutcome,
} from "./alternativesVote";

const valid = { denominator: "valid_votes" } as const;
const present = { denominator: "present" } as const;

describe("computeAlternativesOutcome", () => {
  it("gives the option with most votes, abstentions aside", () => {
    expect(
      computeAlternativesOutcome(
        { options: [12, 8], abstentions: 15 },
        "simple",
        valid,
      ),
    ).toMatchObject({ winner: 0, undecided: null });
    expect(
      computeAlternativesOutcome(
        { options: [3, 9], abstentions: 0 },
        "simple",
        valid,
      ).winner,
    ).toBe(1);
  });

  it("leaves a tie at the top, or no votes, to the Mesa", () => {
    expect(
      computeAlternativesOutcome(
        { options: [7, 7], abstentions: 2 },
        "simple",
        valid,
      ),
    ).toMatchObject({ winner: null, undecided: "tie" });
    expect(
      computeAlternativesOutcome(
        { options: [0, 0], abstentions: 5 },
        "simple",
        valid,
      ).undecided,
    ).toBe("tie");
  });

  it("needs the document's majority where its amendments need one", () => {
    // 30 present: an absolute majority is 16.
    expect(
      computeAlternativesOutcome(
        { options: [15, 10], abstentions: 5, present: 30 },
        "absolute",
        present,
      ),
    ).toMatchObject({ winner: null, undecided: "short", threshold: 16 });
    expect(
      computeAlternativesOutcome(
        { options: [16, 10], abstentions: 4, present: 30 },
        "absolute",
        present,
      ),
    ).toMatchObject({ winner: 0, threshold: 16 });
  });

  it("counts blank ballots as valid and flags more votes than present", () => {
    const outcome = computeAlternativesOutcome(
      { options: [5, 4], abstentions: 0, blank: 2, invalid: 1, present: 12 },
      "simple",
      valid,
    );
    expect(outcome.denominator).toBe(11);
    expect(outcome.inconsistent).toBe(false);
    expect(
      computeAlternativesOutcome(
        { options: [6, 6], abstentions: 1, present: 12 },
        "simple",
        present,
      ).inconsistent,
    ).toBe(true);
  });
});

describe("alternativesSetsProblem", () => {
  it("takes two non-empty, disjoint sets", () => {
    expect(alternativesSetsProblem([["a"], ["b", "c"]])).toBeNull();
    expect(alternativesSetsProblem([["a"]])).toBe("count");
    expect(alternativesSetsProblem([["a"], []])).toBe("empty");
    expect(alternativesSetsProblem([["a", "b"], ["b"]])).toBe("overlap");
  });

  it("names options by letter", () => {
    expect([0, 1, 2].map(alternativeLetter)).toEqual(["A", "B", "C"]);
  });
});

import { describe, expect, it } from "vitest";
import { computeElectionOutcome } from "./election";

const valid = { denominator: "valid_votes" } as const;
const none = { blank: 0, invalid: 0, present: null };

describe("computeElectionOutcome", () => {
  it("elects whoever reaches the absolute majority in the first round", () => {
    expect(
      computeElectionOutcome(
        {
          counts: [12, 8],
          ballots: 20,
          maxChoices: 1,
          rule: "absolute_runoff",
        },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [0], runoff: null, threshold: 11 });
  });

  it("sends the two most voted to a second round when nobody reaches it", () => {
    expect(
      computeElectionOutcome(
        {
          counts: [8, 7, 5],
          ballots: 20,
          maxChoices: 1,
          rule: "absolute_runoff",
        },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [], runoff: [0, 1], tie: false });
  });

  it("counts blank ballots among the votes cast", () => {
    // 10 + 9 marked, 2 blank: 21 cast, 11 needed.
    expect(
      computeElectionOutcome(
        {
          counts: [10, 9],
          ballots: 19,
          maxChoices: 1,
          rule: "absolute_runoff",
        },
        { blank: 2, invalid: 3, present: null },
        valid,
      ),
    ).toMatchObject({ elected: [], runoff: [0, 1], denominator: 21 });
  });

  it("elects the most voted under a simple majority, several posts", () => {
    expect(
      computeElectionOutcome(
        { counts: [3, 9, 6, 1], ballots: 10, maxChoices: 2, rule: "simple" },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [1, 2], runoff: null, tie: false });
  });

  it("leaves a tie at the last post to the Mesa", () => {
    expect(
      computeElectionOutcome(
        { counts: [9, 6, 6], ballots: 10, maxChoices: 2, rule: "simple" },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [0], tie: true });
  });

  it("flags more ballots than members present", () => {
    expect(
      computeElectionOutcome(
        { counts: [5, 5], ballots: 10, maxChoices: 1, rule: "simple" },
        { blank: 1, invalid: 1, present: 11 },
        valid,
      ).inconsistent,
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  alternativesSplitConflict,
  followsProjectedSplit,
  sameAlternatives,
} from "./alternativesSplit";

const A = ["e3", "e5"];
const B = ["e4"];

describe("sameAlternatives", () => {
  it("compares option by option, in any order within one", () => {
    expect(sameAlternatives([A, B], [["e5", "e3"], B])).toBe(true);
    expect(sameAlternatives([A, B], [B, A])).toBe(false);
    expect(sameAlternatives([A, B], [A])).toBe(false);
  });

  it("treats no options as equal only to no options", () => {
    expect(sameAlternatives(null, undefined)).toBe(true);
    expect(sameAlternatives(null, [A, B])).toBe(false);
    expect(sameAlternatives([A, B], null)).toBe(false);
  });
});

describe("alternativesSplitConflict (VOT-1)", () => {
  it("accepts any split with nothing on screen or other amendments on it", () => {
    expect(alternativesSplitConflict(null, [A, B])).toBe(false);
    expect(alternativesSplitConflict([], [A, B])).toBe(false);
    expect(alternativesSplitConflict([["x1"], ["x2"]], [A, B])).toBe(false);
  });

  it("accepts the projected split, in any order within each option", () => {
    expect(alternativesSplitConflict([A, B], [A, B])).toBe(false);
    expect(alternativesSplitConflict([["e5", "e3"], B], [A, B])).toBe(false);
  });

  it("refuses another split of the amendments on screen", () => {
    // Another console moved E5 to option B.
    expect(alternativesSplitConflict([["e3"], ["e4", "e5"]], [A, B])).toBe(
      true,
    );
    // The same sets, swapped: the winner is an option's index.
    expect(alternativesSplitConflict([B, A], [A, B])).toBe(true);
    // Only part of what is on screen, or more than it.
    expect(alternativesSplitConflict([A, B], [["e3"], B])).toBe(true);
    expect(alternativesSplitConflict([["e3"], B], [A, B])).toBe(true);
  });
});

describe("followsProjectedSplit (VOT-1)", () => {
  const ids = ["e3", "e4", "e5"];

  it("takes another split of the same amendments projected meanwhile", () => {
    // Another console moved E5 to option B.
    expect(
      followsProjectedSplit([["e3"], ["e4", "e5"]], [A, B], [A, B], ids),
    ).toBe(true);
    // Projected for the first time, split otherwise than in the dialog.
    expect(followsProjectedSplit([B, A], null, [A, B], ids)).toBe(true);
    // Some still unassigned in the dialog.
    expect(followsProjectedSplit([A, B], null, [["e3"], B], ids)).toBe(true);
  });

  it("never takes over a vote on other amendments", () => {
    // E5 vs E6 entered while the control projects E3 vs E4.
    expect(
      followsProjectedSplit(
        [["e3"], ["e4"]],
        null,
        [["e5"], ["e6"]],
        ["e5", "e6"],
      ),
    ).toBe(false);
  });

  it("leaves the dialog alone when the projection adds or drops amendments", () => {
    expect(
      followsProjectedSplit([["e3"], ["e4", "e7"]], null, [A, B], ids),
    ).toBe(false);
    expect(followsProjectedSplit([["e3"], B], null, [A, B], ids)).toBe(false);
  });

  it("ignores the same split, a refresh of it and no projection", () => {
    expect(followsProjectedSplit([A, B], null, [A, B], ids)).toBe(false);
    expect(followsProjectedSplit([A, B], [A, B], [B, A], ids)).toBe(false);
    expect(followsProjectedSplit(null, [A, B], [B, A], ids)).toBe(false);
  });
});

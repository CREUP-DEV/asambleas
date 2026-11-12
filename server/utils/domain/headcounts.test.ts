import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import type { VoteInput } from "~~/shared/types/api";
import { computeVoteOutcome } from "~~/shared/utils/votes";
import { fillPresent } from "./headcounts";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("./actor", () => ({ canModerate: vi.fn() }));

const latest = { id: "count-1", present: 30 };
const vote: VoteInput = {
  method: "show_of_hands",
  inFavor: 19,
  against: 8,
  abstentions: 3,
};

describe("fillPresent", () => {
  it("fills the members present from the latest count by default", () => {
    expect(fillPresent(vote, latest, DEFAULT_ASSEMBLY_SETTINGS)).toEqual({
      vote: { ...vote, present: 30 },
      headcountId: "count-1",
    });
    expect(
      fillPresent({ ...vote, present: null }, latest, DEFAULT_ASSEMBLY_SETTINGS)
        .vote.present,
    ).toBe(30);
  });

  it("keeps a figure typed for the vote, zero included", () => {
    for (const present of [32, 0]) {
      expect(
        fillPresent({ ...vote, present }, latest, DEFAULT_ASSEMBLY_SETTINGS),
      ).toEqual({ vote: { ...vote, present }, headcountId: "count-1" });
    }
  });

  it("records the count but fills nothing on the valid votes", () => {
    expect(fillPresent(vote, latest, { denominator: "valid_votes" })).toEqual({
      vote,
      headcountId: "count-1",
    });
  });

  it("records nothing without a count or for assent", () => {
    expect(fillPresent(vote, null, DEFAULT_ASSEMBLY_SETTINGS)).toEqual({
      vote,
      headcountId: null,
    });
    const assent: VoteInput = { method: "assent" };
    expect(fillPresent(assent, latest, DEFAULT_ASSEMBLY_SETTINGS)).toEqual({
      vote: assent,
      headcountId: null,
    });
  });

  it("gives the vote the count's base for its majority", () => {
    // 19 of 25 valid votes would pass two thirds (17); of the 30 present
    // it takes 20, and the five who did not vote count against.
    const typed: VoteInput = { ...vote, against: 4, abstentions: 2 };
    const filled = fillPresent(typed, latest, DEFAULT_ASSEMBLY_SETTINGS).vote;
    const outcome = computeVoteOutcome(
      {
        inFavor: filled.inFavor ?? 0,
        against: filled.against ?? 0,
        abstentions: filled.abstentions ?? 0,
        present: filled.present,
      },
      "two_thirds",
      DEFAULT_ASSEMBLY_SETTINGS,
    );
    expect(outcome).toEqual({
      result: "rejected",
      threshold: 20,
      denominator: 30,
      inconsistent: false,
    });
  });
});

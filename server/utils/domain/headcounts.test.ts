import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import type { HeadcountDto, VoteInput } from "~~/shared/types/api";
import { computeVoteOutcome } from "~~/shared/utils/votes";
import { fillPresent, headcountsForReader } from "./headcounts";

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

describe("headcountsForReader", () => {
  const count = (id: string): HeadcountDto => ({
    id,
    eligible: 40,
    inRoom: 25,
    delegated: 5,
    present: 30,
    attending: 3,
    required: 21,
    quorum: true,
    note: null,
    takenAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    entries: [
      {
        member: {
          id: "m1",
          acronym: "CA",
          name: "Consejo A",
          kind: "asociado",
          university: null,
        },
        mark: "present",
        delegate: null,
        voting: true,
      },
    ],
    guests: [{ userId: "u1", name: "Guest" }],
  });
  const dtos = [count("h2"), count("h1")];

  it("gives the Mesa every count whole, which it corrects", () => {
    expect(headcountsForReader(dtos, true)).toEqual({
      headcounts: dtos,
      latest: dtos[0],
    });
  });

  it("gives the room who was counted in the latest count only", () => {
    const view = headcountsForReader(dtos, false);
    expect(view.latest).toBe(dtos[0]);
    expect(view.headcounts.map((item) => item.id)).toEqual(["h2", "h1"]);
    for (const item of view.headcounts) {
      expect(item.entries).toEqual([]);
      expect(item.guests).toEqual([]);
      // The figures stay, attending included.
      expect(item).toMatchObject({ present: 30, attending: 3, quorum: true });
    }
  });

  it("has no latest before the first count", () => {
    expect(headcountsForReader([], false)).toEqual({
      headcounts: [],
      latest: null,
    });
  });
});

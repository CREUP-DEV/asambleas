import { describe, expect, it } from "vitest";
import { INITIAL_CALENDAR_RULES } from "../constants/calendarRules";
import {
  quorumRequired,
  quorumThreshold,
  tallyHeadcount,
  type AttendanceEntry,
} from "./headcount";

const eligible = new Set(["a", "b", "c", "d", "e"]);

describe("tallyHeadcount", () => {
  it("counts members in the room and delegated votes as present", () => {
    const entries: AttendanceEntry[] = [
      { memberId: "a", mark: "present" },
      { memberId: "b", mark: "present" },
      { memberId: "c", mark: "delegated", delegateId: "a" },
    ];
    const tally = tallyHeadcount(entries, eligible);
    expect(tally).toMatchObject({ inRoom: 2, delegated: 1, present: 3 });
    expect(tally.problems.size).toBe(0);
  });

  it("refuses a second delegation to the same member", () => {
    const tally = tallyHeadcount(
      [
        { memberId: "a", mark: "present" },
        { memberId: "b", mark: "delegated", delegateId: "a" },
        { memberId: "c", mark: "delegated", delegateId: "a" },
      ],
      eligible,
    );
    expect(tally.present).toBe(2);
    expect(tally.problems.get("c")).toBe("delegate_twice");
  });

  it("keeps delegations to members out of the room without counting them", () => {
    const tally = tallyHeadcount(
      [
        { memberId: "a", mark: "delegated", delegateId: "b" },
        { memberId: "b", mark: "delegated", delegateId: "c" },
      ],
      eligible,
    );
    expect(tally.present).toBe(0);
    expect(tally.problems.size).toBe(0);
    expect([...tally.uncounted].sort()).toEqual(["a", "b"]);
  });

  it("refuses delegations that name nobody with a vote", () => {
    const tally = tallyHeadcount(
      [
        { memberId: "a", mark: "delegated", delegateId: null },
        { memberId: "b", mark: "delegated", delegateId: "b" },
        { memberId: "c", mark: "delegated", delegateId: "z" },
      ],
      eligible,
    );
    expect(Object.fromEntries(tally.problems)).toEqual({
      a: "delegate_missing",
      b: "delegate_missing",
      c: "delegate_missing",
    });
  });

  it("refuses members without a vote and members listed twice", () => {
    const tally = tallyHeadcount(
      [
        { memberId: "a", mark: "present" },
        { memberId: "a", mark: "present" },
        { memberId: "z", mark: "present" },
      ],
      eligible,
    );
    expect(tally.inRoom).toBe(1);
    expect(tally.problems.get("a")).toBe("duplicate");
    expect(tally.problems.get("z")).toBe("not_eligible");
  });
});

describe("quorumRequired", () => {
  const half = { numerator: 1, denominator: 2, strict: false };
  const moreThanHalf = { ...half, strict: true };
  const third = { numerator: 1, denominator: 3, strict: false };

  it("counts 'at least' a share, rounding up", () => {
    expect(quorumRequired(45, half)).toBe(23);
    expect(quorumRequired(44, half)).toBe(22);
    expect(quorumRequired(45, third)).toBe(15);
    expect(quorumRequired(46, third)).toBe(16);
  });

  it("counts 'more than' a share", () => {
    expect(quorumRequired(44, moreThanHalf)).toBe(23);
    expect(quorumRequired(45, moreThanHalf)).toBe(23);
    expect(quorumRequired(0, moreThanHalf)).toBe(1);
  });

  it("follows the initial rules of each type", () => {
    const ago = INITIAL_CALENDAR_RULES.AGO.quorum!;
    const age = INITIAL_CALENDAR_RULES.AGE.quorum!;
    expect(quorumRequired(40, quorumThreshold(ago, "first"))).toBe(20);
    expect(quorumRequired(40, quorumThreshold(ago, "second"))).toBe(14);
    expect(quorumRequired(40, quorumThreshold(age, "first"))).toBe(21);
    // A type with a single call always uses the first.
    expect(quorumThreshold(age, "second")).toBe(age.firstCall);
  });
});

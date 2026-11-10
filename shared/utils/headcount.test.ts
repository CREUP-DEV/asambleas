import { describe, expect, it } from "vitest";
import { INITIAL_CALENDAR_RULES } from "../constants/calendarRules";
import {
  compareGuests,
  quorumRequired,
  rollCallOrder,
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

  it("follows the initial rules of each type: the call a session opens in", () => {
    // An AGO opens in second call: a third.
    expect(quorumRequired(40, INITIAL_CALENDAR_RULES.AGO.quorum!)).toBe(14);
    // An AGE or an AGET has a single call: more than half.
    expect(quorumRequired(40, INITIAL_CALENDAR_RULES.AGE.quorum!)).toBe(21);
    expect(quorumRequired(40, INITIAL_CALENDAR_RULES.AGET.quorum!)).toBe(21);
  });
});

describe("tallyHeadcount with sectorials", () => {
  const attendees = new Set(["s", "g"]);

  it("writes them down in the room without counting them", () => {
    const tally = tallyHeadcount(
      [
        { memberId: "a", mark: "present" },
        { memberId: "s", mark: "present" },
        { memberId: "g", mark: "present" },
      ],
      eligible,
      attendees,
    );
    expect(tally).toMatchObject({
      inRoom: 1,
      attending: 2,
      delegated: 0,
      present: 1,
    });
    expect(tally.problems.size).toBe(0);
  });

  it("never lets them delegate nor receive a delegation", () => {
    const tally = tallyHeadcount(
      [
        { memberId: "s", mark: "delegated", delegateId: "a" },
        { memberId: "g", mark: "present" },
        { memberId: "b", mark: "delegated", delegateId: "g" },
      ],
      eligible,
      attendees,
    );
    expect(tally.problems.get("s")).toBe("no_vote");
    expect(tally.problems.get("b")).toBe("delegate_missing");
    expect(tally.present).toBe(0);
  });
});

describe("rollCallOrder", () => {
  it("calls asociados, then sectorials, each in reverse alphabetical order", () => {
    const order = rollCallOrder([
      { acronym: "VPO", name: "Vicepresidencia", kind: "executive" as const },
      {
        acronym: "ANEM",
        name: "Asociación Nacional de Matemáticas",
        kind: "sectorial" as const,
      },
      {
        acronym: "RITSI",
        name: "Reunión de Informática",
        kind: "sectorial" as const,
      },
      {
        acronym: "CEUAL",
        name: "Consejo de Estudiantes",
        university: "Universidad de Almería",
        kind: "asociado" as const,
      },
      {
        acronym: "CEUZ",
        name: "Consejo de Estudiantes",
        university: "Universidad de Zaragoza",
        kind: "asociado" as const,
      },
      {
        acronym: "DCEUCM",
        name: "Delegación Central de Estudiantes",
        university: "Universidad Complutense de Madrid",
        kind: "asociado" as const,
      },
      {
        acronym: "CEUÁV",
        name: "Consejo de Estudiantes",
        university: "Universidad de Ávila",
        kind: "asociado" as const,
      },
    ]).map((member) => member.acronym);
    expect(order).toEqual([
      "DCEUCM",
      "CEUZ",
      "CEUÁV",
      "CEUAL",
      "RITSI",
      "ANEM",
      "VPO",
    ]);
  });
});

describe("compareGuests", () => {
  it("calls the guests in reverse alphabetical order of their name", () => {
    expect(
      [{ name: "Ana" }, { name: "Zoe" }, { name: "Álvaro" }]
        .sort(compareGuests)
        .map((guest) => guest.name),
    ).toEqual(["Zoe", "Ana", "Álvaro"]);
  });
});

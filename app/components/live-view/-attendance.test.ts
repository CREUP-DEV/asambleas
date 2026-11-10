import { describe, expect, it } from "vitest";
import type {
  HeadcountDto,
  HeadcountMemberDto,
  HeadcountsDto,
} from "~~/shared/types/api";
import type { MemberKind } from "~~/shared/constants/domain";
import { affectsHeadcounts, liveAttendance } from "./-attendance";

const member = (
  id: string,
  kind: MemberKind = "asociado",
): HeadcountMemberDto => ({
  id,
  acronym: id.toUpperCase(),
  name: `Consejo ${id}`,
  kind,
  university: null,
});

const count = (id: string, present: number): HeadcountDto => ({
  id,
  eligible: 40,
  inRoom: present - 1,
  delegated: 1,
  present,
  attending: 2,
  required: 20,
  quorum: present >= 20,
  note: null,
  takenAt: "2026-11-19T09:00:00.000Z",
  updatedAt: "2026-11-19T09:00:00.000Z",
  // In the order of the roll call, as the server sends them.
  entries: [
    { member: member("b"), mark: "present", delegate: null, voting: true },
    { member: member("a"), mark: "present", delegate: null, voting: true },
    {
      member: member("c"),
      mark: "delegated",
      delegate: member("a"),
      voting: true,
    },
    {
      member: member("d"),
      mark: "delegated",
      delegate: member("e"),
      voting: true,
    },
    {
      member: member("s", "sectorial"),
      mark: "present",
      delegate: null,
      voting: false,
    },
  ],
  guests: [{ userId: "u1", name: "Ana Invitada" }],
});

const dto = (counts: HeadcountDto[]): HeadcountsDto => ({
  headcounts: counts,
  latest: counts[0] ?? null,
  members: [],
  guests: [],
  quorum: { numerator: 1, denominator: 2, strict: false },
});

describe("liveAttendance", () => {
  it("is null before the first headcount", () => {
    expect(liveAttendance(dto([]), { denominator: "present" })).toBeNull();
    expect(liveAttendance(null, { denominator: "present" })).toBeNull();
  });

  it("gives the majorities on the members present", () => {
    const view = liveAttendance(dto([count("h2", 35), count("h1", 30)]), {
      denominator: "present",
    })!;
    expect(view.majorities).toEqual({ absolute: 18, twoThirds: 24 });
    expect(view.earlier.map((item) => item.id)).toEqual(["h1"]);
  });

  it("gives no majorities when they are counted on the valid votes", () => {
    const view = liveAttendance(dto([count("h1", 30)]), {
      denominator: "valid_votes",
    })!;
    expect(view.majorities).toBeNull();
  });

  it("lists who is in the room, in roll-call order, and which delegations count", () => {
    const view = liveAttendance(dto([count("h1", 30)]), {
      denominator: "present",
    })!;
    expect(view.inRoom.map((item) => item.id)).toEqual(["b", "a"]);
    expect(
      view.delegations.map((item) => [item.from.id, item.to.id, item.counts]),
    ).toEqual([
      ["c", "a", true],
      ["d", "e", false],
    ]);
  });

  it("lists the sectorials and guests in the room apart, without a vote", () => {
    const view = liveAttendance(dto([count("h1", 30)]), {
      denominator: "present",
    })!;
    expect(view.attending.map((item) => item.id)).toEqual(["s"]);
    expect(view.guests).toEqual(["Ana Invitada"]);
    expect(view.inRoom.map((item) => item.id)).not.toContain("s");
  });

  it("refreshes on headcount events and polls only", () => {
    const event = (entityType: string, type = "x") => ({
      assemblyId: "a",
      entityType,
      entityId: "e",
      type,
    });
    expect(affectsHeadcounts([event("headcount")])).toBe(true);
    expect(affectsHeadcounts([event("live", "poll")])).toBe(true);
    expect(affectsHeadcounts([event("speakers")])).toBe(false);
  });
});

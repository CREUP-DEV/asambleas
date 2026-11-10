import { describe, expect, it } from "vitest";
import type { HeadcountDto, HeadcountMemberDto } from "~~/shared/types/api";
import type { MemberKind } from "~~/shared/constants/domain";
import {
  delegateOptions,
  headcountEntriesOf,
  headcountFormFrom,
  headcountFormMembers,
  delegationsReceived,
  setHeadcountDelegate,
  setHeadcountPresent,
  type HeadcountForm,
} from "./headcountForm";

const member = (
  id: string,
  kind: MemberKind = "asociado",
  name = `Consejo ${id}`,
): HeadcountMemberDto => ({
  id,
  acronym: id.toUpperCase(),
  name,
  kind,
  university: null,
});

const members = ["c", "b", "a"].map((id) => member(id));

const previous: HeadcountDto = {
  id: "h1",
  call: "second",
  eligible: 4,
  inRoom: 2,
  delegated: 1,
  present: 3,
  attending: 0,
  required: 2,
  quorum: true,
  note: null,
  takenAt: "2026-11-19T09:00:00.000Z",
  updatedAt: "2026-11-19T09:00:00.000Z",
  entries: [
    { member: member("a"), mark: "present", delegate: null, voting: true },
    {
      member: member("b"),
      mark: "delegated",
      delegate: member("a"),
      voting: true,
    },
    { member: member("x"), mark: "present", delegate: null, voting: true },
  ],
};

const formMembers = headcountFormMembers(members, null);

describe("headcount form", () => {
  it("starts from the previous count, for the members with a vote now", () => {
    const form = headcountFormFrom(formMembers, previous);
    expect(form).toEqual({
      a: { present: true, delegateId: null },
      b: { present: false, delegateId: "a" },
      c: { present: false, delegateId: null },
    });
    // In the order of the form: reverse alphabetical, so b before a.
    expect(headcountEntriesOf(form)).toEqual([
      { memberId: "b", mark: "delegated", delegateId: "a" },
      { memberId: "a", mark: "present" },
    ]);
  });

  it("keeps a corrected count's members that no longer have a vote", () => {
    expect(
      headcountFormMembers(members, previous).map((item) => item.id),
    ).toEqual(["x", "c", "b", "a"]);
  });

  it("lists asociados, then sectorials, then guests, each in reverse alphabetical order", () => {
    const list = headcountFormMembers(
      [
        member("g1", "guest", "Asociación de antiguos"),
        member("s1", "sectorial", "Asociación de Química"),
        member("s2", "sectorial", "Reunión de Informática"),
        {
          ...member("c1", "asociado", "Consejo de Estudiantes"),
          university: "Universidad de Almería",
        },
        {
          ...member("c2", "asociado", "Consejo de Estudiantes"),
          university: "Universidad de Zaragoza",
        },
        member("d1", "asociado", "Delegación de Alumnos"),
      ],
      null,
    );
    expect(list.map((item) => [item.id, item.voting])).toEqual([
      ["d1", true],
      ["c2", true],
      ["c1", true],
      ["s2", false],
      ["s1", false],
      ["g1", false],
    ]);
  });

  it("keeps a corrected count's own idea of who voted", () => {
    const target: HeadcountDto = {
      ...previous,
      entries: [
        // A guest now that voted then, and an asociado now listed without a vote.
        {
          member: member("old", "guest"),
          mark: "present",
          delegate: null,
          voting: true,
        },
        { member: member("a"), mark: "present", delegate: null, voting: false },
      ],
    };
    const list = headcountFormMembers(members, target);
    expect(list.find((item) => item.id === "old")?.voting).toBe(true);
    expect(list.find((item) => item.id === "a")?.voting).toBe(false);
  });

  it("never carries a delegation of a member without a vote", () => {
    const list = headcountFormMembers(
      [...members, member("s", "sectorial")],
      null,
    );
    const form = headcountFormFrom(list, {
      ...previous,
      entries: [
        {
          member: member("s", "sectorial"),
          mark: "delegated",
          delegate: member("a"),
          voting: false,
        },
      ],
    });
    expect(form.s).toEqual({ present: false, delegateId: null });
  });

  it("offers delegates that hold no delegation, those in the room first", () => {
    const order = ["a", "b", "c", "d"];
    let form: HeadcountForm = {
      ...headcountFormFrom(formMembers, previous),
      d: { present: true, delegateId: null },
    };
    // a already receives b's vote; b delegates its own.
    expect(delegateOptions(form, "c", order)).toEqual(["d"]);
    // b keeps its own receiver on offer.
    expect(delegateOptions(form, "b", order)).toEqual(["a", "d", "c"]);
    form = setHeadcountPresent(form, "d", false);
    expect(delegateOptions(form, "c", order)).toEqual(["d"]);
  });

  it("keeps a delegation when its receiver leaves the room", () => {
    const form = setHeadcountPresent(
      headcountFormFrom(formMembers, previous),
      "a",
      false,
    );
    expect(form.b).toEqual({ present: false, delegateId: "a" });
    expect(delegationsReceived(form).get("a")).toBe("b");
  });

  it("drops a member's delegation once it is in the room", () => {
    let form = setHeadcountDelegate(
      headcountFormFrom(formMembers, previous),
      "c",
      "a",
    );
    expect(form.c).toEqual({ present: false, delegateId: "a" });
    form = setHeadcountPresent(form, "c", true);
    expect(form.c).toEqual({ present: true, delegateId: null });
  });
});

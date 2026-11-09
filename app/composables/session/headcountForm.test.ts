import { describe, expect, it } from "vitest";
import type { HeadcountDto, MemberRef } from "~~/shared/types/api";
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

const member = (id: string): MemberRef => ({
  id,
  acronym: id.toUpperCase(),
  name: `Consejo ${id}`,
  kind: "asociado",
});

const members = ["a", "b", "c"].map(member);

const previous: HeadcountDto = {
  id: "h1",
  call: "first",
  eligible: 4,
  inRoom: 2,
  delegated: 1,
  present: 3,
  required: 2,
  quorum: true,
  note: null,
  takenAt: "2026-11-19T09:00:00.000Z",
  updatedAt: "2026-11-19T09:00:00.000Z",
  entries: [
    { member: member("a"), mark: "present", delegate: null },
    { member: member("b"), mark: "delegated", delegate: member("a") },
    { member: member("x"), mark: "present", delegate: null },
  ],
};

describe("headcount form", () => {
  it("starts from the previous count, for the members with a vote now", () => {
    const form = headcountFormFrom(members, previous);
    expect(form).toEqual({
      a: { present: true, delegateId: null },
      b: { present: false, delegateId: "a" },
      c: { present: false, delegateId: null },
    });
    expect(headcountEntriesOf(form)).toEqual([
      { memberId: "a", mark: "present" },
      { memberId: "b", mark: "delegated", delegateId: "a" },
    ]);
  });

  it("keeps a corrected count's members that no longer have a vote", () => {
    expect(
      headcountFormMembers(members, previous).map((item) => item.id),
    ).toEqual(["a", "b", "c", "x"]);
  });

  it("offers delegates that hold no delegation, those in the room first", () => {
    const order = ["a", "b", "c", "d"];
    let form: HeadcountForm = {
      ...headcountFormFrom(members, previous),
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
      headcountFormFrom(members, previous),
      "a",
      false,
    );
    expect(form.b).toEqual({ present: false, delegateId: "a" });
    expect(delegationsReceived(form).get("a")).toBe("b");
  });

  it("drops a member's delegation once it is in the room", () => {
    let form = setHeadcountDelegate(
      headcountFormFrom(members, previous),
      "c",
      "a",
    );
    expect(form.c).toEqual({ present: false, delegateId: "a" });
    form = setHeadcountPresent(form, "c", true);
    expect(form.c).toEqual({ present: true, delegateId: null });
  });
});

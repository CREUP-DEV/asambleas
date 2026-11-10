import { describe, expect, it } from "vitest";
import type { MemberKind } from "../constants/domain";
import { orderMembers } from "./memberOrder";

function member(acronym: string, kind: MemberKind, active = true) {
  return { acronym, kind, active };
}

const list = [
  member("VDT", "executive"),
  member("AEAE", "sectorial"),
  member("CEUM", "asociado"),
  member("INV", "other"),
  member("CADUS", "asociado"),
  member("PRES", "executive"),
  member("ZZZ", "asociado", false),
];

const acronyms = (members: { acronym: string }[]) =>
  members.map((item) => item.acronym);

describe("orderMembers", () => {
  it("lists asociados, sectorials, others and offices, each by acronym", () => {
    expect(acronyms(orderMembers(list))).toEqual([
      "CADUS",
      "CEUM",
      "AEAE",
      "INV",
      "PRES",
      "VDT",
      "ZZZ",
    ]);
  });

  it("puts the viewer's kind first and keeps the rest in order", () => {
    expect(acronyms(orderMembers(list, "sectorial"))).toEqual([
      "AEAE",
      "CADUS",
      "CEUM",
      "INV",
      "PRES",
      "VDT",
      "ZZZ",
    ]);
    expect(acronyms(orderMembers(list, "executive")).slice(0, 2)).toEqual([
      "PRES",
      "VDT",
    ]);
  });

  it("does not change the list it is given", () => {
    const before = acronyms(list);
    orderMembers(list, "executive");
    expect(acronyms(list)).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import { GENERIC_EXECUTIVE_MEMBER_ID } from "~~/shared/constants/domain";
import {
  AMENDMENT_AUTHORS_QUERY,
  addableMembers,
  executiveMembersOf,
  genericExecutiveAcronym,
  hidesExecutiveAuthors,
  isGenericExecutiveMember,
  withFixedGenericExecutive,
} from "./executiveMembers";

const GENERIC = { id: GENERIC_EXECUTIVE_MEMBER_ID, acronym: "CEA" };
const COUNCIL = { id: "council", acronym: "CEUM" };
const SECTORIAL = { id: "sectorial", acronym: "CREARQ" };

describe("isGenericExecutiveMember", () => {
  it("is true only for the generic id", () => {
    expect(isGenericExecutiveMember(GENERIC_EXECUTIVE_MEMBER_ID)).toBe(true);
    expect(isGenericExecutiveMember(COUNCIL.id)).toBe(false);
    expect(isGenericExecutiveMember(null)).toBe(false);
    expect(isGenericExecutiveMember(undefined)).toBe(false);
  });
});

describe("addableMembers", () => {
  it("never offers the generic CEA", () => {
    expect(addableMembers([COUNCIL, GENERIC, SECTORIAL])).toEqual([
      COUNCIL,
      SECTORIAL,
    ]);
  });

  it("leaves a list without it as it is", () => {
    expect(addableMembers([COUNCIL, SECTORIAL])).toEqual([COUNCIL, SECTORIAL]);
    expect(addableMembers([])).toEqual([]);
  });
});

describe("withFixedGenericExecutive", () => {
  it("fixes the generic CEA when it is among the current ones", () => {
    expect(
      withFixedGenericExecutive(
        [COUNCIL.id],
        [GENERIC_EXECUTIVE_MEMBER_ID, SECTORIAL.id],
      ),
    ).toEqual([COUNCIL.id, GENERIC_EXECUTIVE_MEMBER_ID]);
  });

  it("adds nothing when it is not there or is fixed already", () => {
    expect(withFixedGenericExecutive([COUNCIL.id], [SECTORIAL.id])).toEqual([
      COUNCIL.id,
    ]);
    expect(
      withFixedGenericExecutive(
        [GENERIC_EXECUTIVE_MEMBER_ID],
        [GENERIC_EXECUTIVE_MEMBER_ID],
      ),
    ).toEqual([GENERIC_EXECUTIVE_MEMBER_ID]);
  });
});

describe("hidesExecutiveAuthors", () => {
  it("is true when the generic CEA is among the authors", () => {
    expect(hidesExecutiveAuthors([COUNCIL, GENERIC])).toBe(true);
    expect(hidesExecutiveAuthors([GENERIC])).toBe(true);
  });

  it("is false when every author is a real member", () => {
    expect(hidesExecutiveAuthors([COUNCIL, SECTORIAL])).toBe(false);
    expect(hidesExecutiveAuthors([])).toBe(false);
  });
});

describe("executiveMembersOf", () => {
  it("keeps the real executive areas, never the generic CEA", () => {
    const area = { id: "area", acronym: "VDT", kind: "executive" };
    expect(
      executiveMembersOf([
        { ...COUNCIL, kind: "council" },
        area,
        { ...GENERIC, kind: "executive" },
      ]),
    ).toEqual([area]);
  });
});

describe("AMENDMENT_AUTHORS_QUERY", () => {
  it("asks for the list of the amendment composers", () => {
    expect(AMENDMENT_AUTHORS_QUERY).toEqual({ for: "amendment" });
  });
});

describe("genericExecutiveAcronym", () => {
  it("names the generic id and nothing else", () => {
    expect(genericExecutiveAcronym(GENERIC_EXECUTIVE_MEMBER_ID)).toBe("CEA");
    expect(genericExecutiveAcronym(COUNCIL.id)).toBeNull();
    expect(genericExecutiveAcronym(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { accountAvatarText } from "./accountAvatar";

const council = {
  kind: "asociado" as const,
  acronym: "CGEUGR",
  universityAcronym: "UGR",
};

describe("accountAvatarText", () => {
  it("reads a council's university acronym, the account's first", () => {
    expect(accountAvatarText({ universityAcronym: null }, council)).toBe("UGR");
    expect(accountAvatarText({ universityAcronym: "UVa" }, council)).toBe(
      "UVa",
    );
  });

  it("reads the university of an account with no member, such as a guest council", () => {
    expect(accountAvatarText({ universityAcronym: "UC3M" }, null)).toBe("UC3M");
  });

  it("reads the acronym of a sectorial, an office or the CAS, never a university", () => {
    for (const kind of ["sectorial", "executive", "other"] as const) {
      expect(
        accountAvatarText(
          { universityAcronym: "Ruido" },
          { kind, acronym: "ANEM", universityAcronym: null },
        ),
      ).toBe("ANEM");
    }
  });

  it("falls back to the council's acronym, then to nothing", () => {
    expect(
      accountAvatarText(
        { universityAcronym: " " },
        { ...council, universityAcronym: null },
      ),
    ).toBe("CGEUGR");
    expect(accountAvatarText({ universityAcronym: null }, null)).toBeNull();
  });
});

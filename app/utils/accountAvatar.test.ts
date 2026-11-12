import { describe, expect, it } from "vitest";
import { avatarDisplayText, avatarTextClass } from "./accountAvatar";

describe("avatarDisplayText", () => {
  it("draws acronyms of up to four letters as they are", () => {
    expect(avatarDisplayText("UVa")).toBe("UVa");
    expect(avatarDisplayText(" UPCT ")).toBe("UPCT");
  });

  it("leaves longer ones and none to the initials of the name", () => {
    expect(avatarDisplayText("ULPGC")).toBeUndefined();
    expect(avatarDisplayText("  ")).toBeUndefined();
    expect(avatarDisplayText(null)).toBeUndefined();
  });
});

describe("avatarTextClass", () => {
  it("shrinks the type as the acronym grows", () => {
    expect(avatarTextClass("SE")).toBe("");
    expect(avatarTextClass("UGR")).toBe("text-[11px]");
    expect(avatarTextClass("ANEM")).toBe("text-[9px]");
    expect(avatarTextClass("ANEM", "md")).toBe("text-[10px]");
  });

  it("keeps UAvatar's own size when the initials are drawn instead", () => {
    expect(avatarTextClass("AERRAAITI")).toBe("");
  });
});

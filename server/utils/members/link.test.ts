import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../core/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

const {
  INTRANET_MEMBER_TYPES,
  canLinkToMember,
  initialsToAcronym,
  keepsCurrentLink,
  newLinkedMember,
} = await import("./link");

const now = new Date("2026-11-05T10:00:00Z");

describe("INTRANET_MEMBER_TYPES", () => {
  it("links CEA accounts to executive areas", () => {
    expect(INTRANET_MEMBER_TYPES.get("CEA")).toBe("executive");
    expect(INTRANET_MEMBER_TYPES.get("Asociado")).toBe("asociado");
    expect(INTRANET_MEMBER_TYPES.get("Sectorial")).toBe("sectorial");
    expect(INTRANET_MEMBER_TYPES.get("Alumni")).toBeUndefined();
  });
});

describe("initialsToAcronym", () => {
  it("normalizes spaces and refuses empty initials", () => {
    expect(initialsToAcronym("  DA   UPM ")).toBe("DA UPM");
    expect(initialsToAcronym("   ")).toBeNull();
    expect(initialsToAcronym(null)).toBeNull();
  });
});

describe("canLinkToMember", () => {
  it("never links a CEA account to a council or a sectorial", () => {
    expect(canLinkToMember("executive", "executive")).toBe(true);
    expect(canLinkToMember("executive", "other")).toBe(true);
    expect(canLinkToMember("executive", "asociado")).toBe(false);
    expect(canLinkToMember("executive", "sectorial")).toBe(false);
  });

  it("keeps linking councils and sectorials by acronym", () => {
    expect(canLinkToMember("asociado", "asociado")).toBe(true);
    expect(canLinkToMember("sectorial", "other")).toBe(true);
  });
});

describe("newLinkedMember", () => {
  const identity = {
    name: "Consejo de Estudiantes",
    university: "Universidad de Murcia",
  };

  it("creates councils from the intranet data", () => {
    expect(newLinkedMember("asociado", "CEUM", identity, now)).toEqual({
      kind: "asociado",
      acronym: "CEUM",
      name: "Consejo de Estudiantes",
      university: "Universidad de Murcia",
      source: "intranet",
      active: true,
      syncedAt: now,
    });
  });

  it("creates executive areas as manual members named by their acronym", () => {
    expect(
      newLinkedMember("executive", "VPU", { name: "Ana", university: null }),
    ).toMatchObject({
      kind: "executive",
      acronym: "VPU",
      name: "VPU",
      university: null,
      source: "manual",
      syncedAt: null,
    });
  });

  it("falls back to the acronym without a name", () => {
    expect(
      newLinkedMember("sectorial", "CEEM", { name: " ", university: "X" }, now),
    ).toMatchObject({ name: "CEEM", university: null });
  });
});

describe("keepsCurrentLink", () => {
  const link = (
    kind: "asociado" | "sectorial" | "executive",
    currentMemberId: string | null,
    previousInitials: string | null,
    initials: string | null,
  ) => keepsCurrentLink({ kind, currentMemberId, previousInitials, initials });

  it("keeps the area of a linked CEA account, even one set by hand", () => {
    expect(link("executive", "m-vpu", "AGL", "AGL")).toBe(true);
    expect(link("executive", "m-vpu", "vpu ", "VPU")).toBe(true);
  });

  it("links a CEA account again when its initials change", () => {
    expect(link("executive", "m-vpu", "VPU", "SG")).toBe(false);
    expect(link("executive", "m-vpu", null, "VPU")).toBe(false);
  });

  it("links an account that acts for no member", () => {
    expect(link("executive", null, "VPU", "VPU")).toBe(false);
  });

  it("makes councils and sectorials always follow their initials", () => {
    expect(link("asociado", "m-ceum", "CEUM", "CEUM")).toBe(false);
    expect(link("sectorial", "m-ceem", "CEEM", "CEEM")).toBe(false);
  });
});

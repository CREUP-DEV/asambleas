import { describe, expect, it, vi } from "vitest";
import { GENERIC_EXECUTIVE_MEMBER } from "~~/shared/constants/domain";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { MemberRef } from "~~/shared/types/api";
import type { PresenceEntry } from "../live/presence";
import type { Actor } from "./actor";

// Only the pure mapping runs here: the loaders need the database.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { presenceForViewer } = await import("./documentPresenceView");

const OFFICE: MemberRef = {
  id: "officeaaaaaaaaaaaaaaaaaa",
  acronym: "SE",
  name: "Secretaría Ejecutiva",
  kind: "executive",
};
const COUNCIL: MemberRef = {
  id: "councilaaaaaaaaaaaaaaaaa",
  acronym: "CEUM",
  name: "Consejo de Estudiantes",
  kind: "asociado",
};

function viewer(userId: string, role: string, member: MemberRef | null): Actor {
  return {
    user: {
      id: userId,
      name: "Viewer",
      email: "viewer@example.org",
      image: null,
      roleId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: member?.id ?? null,
      lastRoleSyncAt: null,
      role: { id: "role", name: role },
    },
    memberId: member?.id ?? null,
    memberKind: member?.kind ?? null,
    isAdmin: false,
    permissions: [],
    can: () => false,
    impersonation: null,
  };
}

function entry(
  userId: string,
  name: string,
  member: MemberRef | null,
  unsaved = false,
): PresenceEntry {
  return {
    userId,
    tabId: `tab-${userId}`,
    name,
    member,
    unsaved,
    since: 0,
    seenAt: 0,
  };
}

const council = viewer("council-user", SYSTEM_ROLES.ASOCIADO, COUNCIL);
const office = viewer("office-user", SYSTEM_ROLES.CEA, OFFICE);

describe("presenceForViewer", () => {
  it("hides the office and the person who acts for it from a council", () => {
    expect(
      presenceForViewer(council, [entry("office-user", "Marta", OFFICE, true)]),
    ).toEqual([
      {
        name: null,
        member: { ...GENERIC_EXECUTIVE_MEMBER },
        sameAccount: false,
        unsaved: true,
      },
    ]);
  });

  it("names the office for an account that acts for one", () => {
    expect(
      presenceForViewer(office, [entry("other-office", "Marta", OFFICE)]),
    ).toEqual([
      { name: "Marta", member: OFFICE, sameAccount: false, unsaved: false },
    ]);
  });

  it("names who acts for a council, and marks the viewer's own account", () => {
    expect(
      presenceForViewer(council, [
        entry("council-user", "Luis", COUNCIL),
        entry("someone", "Sara", null),
      ]),
    ).toEqual([
      { name: "Luis", member: COUNCIL, sameAccount: true, unsaved: false },
      { name: "Sara", member: null, sameAccount: false, unsaved: false },
    ]);
  });
});

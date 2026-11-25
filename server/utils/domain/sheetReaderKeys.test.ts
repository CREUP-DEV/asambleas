import { describe, expect, it, vi } from "vitest";
import {
  ALL_PERMISSION_KEYS,
  CONTROL_SHEET_READER_KEYS,
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { Actor } from "./actor";

// Who reads the control sheet, and what it lists, is one rule (ARQ-20):
// canViewControlSheet and the amendments only the sheet's readers see.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { canReviewAmendments, canViewControlSheet, canViewSeating } =
  await import("./actor");
const {
  canSeeAmendment,
  canSeeExecutiveMembers,
  isCeaAccount,
  seesAllPresentedAmendments,
  seesValidatedAmendments,
  seesWithdrawnAmendments,
} = await import("./visibility");

function makeActor(permissions: PermissionKey[], role: string | null = null) {
  const actor: Actor = {
    user: {
      id: "u".repeat(32),
      name: "Ana",
      email: "ana@example.org",
      image: null,
      roleId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      memberId: null,
      lastRoleSyncAt: null,
      role: role ? { id: "role", name: role } : null,
    },
    memberId: null,
    memberKind: null,
    isAdmin: false,
    permissions,
    can: (key) => permissions.includes(key),
    impersonation: null,
  };
  return actor;
}

/** Someone else's amendment, presented and validated or withdrawn. */
function amendment(status: "submitted" | "withdrawn") {
  return {
    kind: "partial" as const,
    status,
    publishedAt: null,
    validatedAt: new Date("2026-11-20T10:00:00Z"),
    documentPresenters: { proponentMemberId: null, coProponentMemberIds: [] },
    createdByUserId: "c".repeat(32),
    authorMemberIds: ["m".repeat(24)],
    partyMemberIds: [],
  };
}

describe("the control sheet's readers", () => {
  it("are the same accounts for the sheet and for the amendments it lists", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      const actor = makeActor([key]);
      const reads = CONTROL_SHEET_READER_KEYS.includes(key);
      expect(canViewControlSheet(actor), key).toBe(reads);
      // Reviewers and the Mesa see every presented amendment anyway.
      if (seesAllPresentedAmendments(actor)) continue;
      expect(seesValidatedAmendments(actor), key).toBe(reads);
      expect(seesWithdrawnAmendments(actor), key).toBe(reads);
      expect(canSeeAmendment(actor, amendment("submitted")), key).toBe(reads);
      expect(canSeeAmendment(actor, amendment("withdrawn")), key).toBe(reads);
    }
  });

  it("see the executive offices, as the sheet names them", () => {
    for (const key of CONTROL_SHEET_READER_KEYS) {
      expect(canSeeExecutiveMembers(makeActor([key])), key).toBe(true);
    }
  });

  it("leave out an account with no key", () => {
    const nobody = makeActor([]);
    expect(canViewControlSheet(nobody)).toBe(false);
    expect(seesValidatedAmendments(nobody)).toBe(false);
    expect(seesWithdrawnAmendments(nobody)).toBe(false);
    expect(canSeeAmendment(nobody, amendment("submitted"))).toBe(false);
    expect(canSeeAmendment(nobody, amendment("withdrawn"))).toBe(false);
    expect(canSeeExecutiveMembers(nobody)).toBe(false);
  });

  it("add the CEA's accounts to who sees what the sheet lists", () => {
    const cea = makeActor([], SYSTEM_ROLES.CEA);
    expect(isCeaAccount(cea)).toBe(true);
    expect(canViewControlSheet(cea)).toBe(false);
    expect(seesValidatedAmendments(cea)).toBe(true);
    expect(seesWithdrawnAmendments(cea)).toBe(true);
  });
});

describe("keys that imply another", () => {
  it("let amendment:manage review amendments, as amendment:review does", () => {
    const manager = makeActor([PERMISSION_KEYS.AMENDMENT_MANAGE]);
    expect(canReviewAmendments(manager)).toBe(true);
    expect(seesAllPresentedAmendments(manager)).toBe(true);
    expect(canSeeExecutiveMembers(manager)).toBe(true);
    expect(canReviewAmendments(makeActor([]))).toBe(false);
  });

  it("let seating:edit read the room", () => {
    expect(canViewSeating(makeActor([PERMISSION_KEYS.SEATING_EDIT]))).toBe(
      true,
    );
    expect(canViewSeating(makeActor([PERMISSION_KEYS.SEATING_VIEW]))).toBe(
      true,
    );
    expect(canViewSeating(makeActor([]))).toBe(false);
  });
});

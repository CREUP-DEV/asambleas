import { describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

// Only the pure merge is tested: stub the database and the session helpers.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));

const {
  ADMIN_SECTION_PERMISSIONS,
  adminGrantViolation,
  getEffectivePermissions,
  hasAnyPermission,
  mergePermissions,
} = await import("./rbac");

describe("hasAnyPermission", () => {
  it("opens the admin section with either users or roles", () => {
    expect(
      hasAnyPermission(
        [PERMISSION_KEYS.USER_MANAGE_ROLES],
        ADMIN_SECTION_PERMISSIONS,
      ),
    ).toBe(true);
    expect(
      hasAnyPermission(
        [PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS],
        ADMIN_SECTION_PERMISSIONS,
      ),
    ).toBe(true);
  });

  it("keeps everyone else out", () => {
    expect(
      hasAnyPermission(
        [PERMISSION_KEYS.DOCUMENT_MANAGE, PERMISSION_KEYS.MEMBER_MANAGE],
        ADMIN_SECTION_PERMISSIONS,
      ),
    ).toBe(false);
    expect(hasAnyPermission([], ADMIN_SECTION_PERMISSIONS)).toBe(false);
  });
});

describe("mergePermissions", () => {
  it("adds the user's grants to the role's, without duplicates", () => {
    expect(
      mergePermissions(
        [PERMISSION_KEYS.DOCUMENT_CREATE, PERMISSION_KEYS.AMENDMENT_CREATE],
        [PERMISSION_KEYS.SESSION_MODERATE, PERMISSION_KEYS.DOCUMENT_CREATE],
      ),
    ).toEqual([
      PERMISSION_KEYS.DOCUMENT_CREATE,
      PERMISSION_KEYS.AMENDMENT_CREATE,
      PERMISSION_KEYS.SESSION_MODERATE,
    ]);
  });

  it("drops keys that are no longer in the catalog", () => {
    expect(
      mergePermissions(["legacy:key"], [PERMISSION_KEYS.MEMBER_MANAGE]),
    ).toEqual([PERMISSION_KEYS.MEMBER_MANAGE]);
  });

  it("works with no role and no grants", () => {
    expect(mergePermissions([], [])).toEqual([]);
  });
});

describe("getEffectivePermissions", () => {
  it("gives Admin every key without reading grants", async () => {
    const keys = await getEffectivePermissions({
      id: "u1",
      role: { id: "r1", name: "Admin" },
    });
    expect(keys).toEqual(Object.values(PERMISSION_KEYS));
  });
});

describe("adminGrantViolation", () => {
  const { USER_MANAGE_ROLES, ROLE_MANAGE_PERMISSIONS, SESSION_MODERATE } =
    PERMISSION_KEYS;
  const base = {
    admin: false,
    callerPermissions: [USER_MANAGE_ROLES, SESSION_MODERATE],
    ownTarget: false,
  };

  it("keeps a non-Admin away from its own account and role", () => {
    expect(
      adminGrantViolation({ ...base, ownTarget: true, target: "account" }),
    ).toBe("own_account");
    expect(
      adminGrantViolation({ ...base, ownTarget: true, target: "role" }),
    ).toBe("own_role");
  });

  it("lets an Admin change anything, its own account included", () => {
    expect(
      adminGrantViolation({
        ...base,
        admin: true,
        callerPermissions: [],
        ownTarget: true,
        target: "account",
        before: [],
        after: [ROLE_MANAGE_PERMISSIONS],
      }),
    ).toBeNull();
  });

  it("refuses adding or removing a key the caller does not hold", () => {
    expect(
      adminGrantViolation({
        ...base,
        target: "account",
        before: [],
        after: [ROLE_MANAGE_PERMISSIONS],
      }),
    ).toBe("not_held");
    expect(
      adminGrantViolation({
        ...base,
        target: "role",
        before: [ROLE_MANAGE_PERMISSIONS],
        after: [],
      }),
    ).toBe("not_held");
  });

  it("only looks at the keys that change", () => {
    expect(
      adminGrantViolation({
        ...base,
        target: "account",
        before: [ROLE_MANAGE_PERMISSIONS],
        after: [ROLE_MANAGE_PERMISSIONS, SESSION_MODERATE],
      }),
    ).toBeNull();
    expect(
      adminGrantViolation({ ...base, target: "role", before: [], after: [] }),
    ).toBeNull();
  });
});

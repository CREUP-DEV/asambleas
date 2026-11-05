import { describe, expect, it, vi } from "vitest";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

// Only the pure merge is tested: stub the database and the session helpers.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));

const { getEffectivePermissions, mergePermissions } = await import("./rbac");

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

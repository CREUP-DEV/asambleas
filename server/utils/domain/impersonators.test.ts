import { describe, expect, it, vi } from "vitest";

// Only the pure helpers are tested here: the loader needs the database.
vi.mock("../../db", () => ({ db: {} }));

const { impersonatedByFor, seesImpersonator } = await import("./impersonators");

const ACCOUNT = "t".repeat(32);
const OTHER = "o".repeat(32);
const ADMIN = "a".repeat(32);

const viewer = (id: string, isAdmin = false) => ({ user: { id }, isAdmin });
const impersonators = new Map([
  ["imp1", { adminUserId: ADMIN, admin: { id: ADMIN, name: "Admin" } }],
]);

describe("seesImpersonator", () => {
  it("is the account acted as and Admins only", () => {
    expect(seesImpersonator(viewer(ACCOUNT), ACCOUNT)).toBe(true);
    expect(seesImpersonator(viewer(OTHER, true), ACCOUNT)).toBe(true);
    expect(seesImpersonator(viewer(OTHER), ACCOUNT)).toBe(false);
    expect(seesImpersonator(viewer(OTHER), null)).toBe(false);
  });
});

describe("impersonatedByFor", () => {
  const act = { actorUserId: ACCOUNT, impersonationId: "imp1" };

  it("names the Admin to the account and to Admins", () => {
    expect(impersonatedByFor(viewer(ACCOUNT), act, impersonators)).toEqual({
      id: ADMIN,
      name: "Admin",
    });
    expect(impersonatedByFor(viewer(OTHER, true), act, impersonators)).toEqual({
      id: ADMIN,
      name: "Admin",
    });
  });

  it("names nobody to anyone else, or for an act done as oneself", () => {
    expect(impersonatedByFor(viewer(OTHER), act, impersonators)).toBeNull();
    expect(
      impersonatedByFor(
        viewer(ACCOUNT),
        { actorUserId: ACCOUNT, impersonationId: null },
        impersonators,
      ),
    ).toBeNull();
    // The impersonation's own rows are the Admin's.
    expect(
      impersonatedByFor(
        viewer(ADMIN, true),
        { actorUserId: ADMIN, impersonationId: "imp1" },
        impersonators,
      ),
    ).toBeNull();
    expect(
      impersonatedByFor(
        viewer(ACCOUNT),
        { actorUserId: ACCOUNT, impersonationId: "unknown" },
        impersonators,
      ),
    ).toBeNull();
  });
});

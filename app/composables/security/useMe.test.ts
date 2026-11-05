import { describe, expect, it } from "vitest";
import type { MeImpersonationDto } from "~~/shared/types/api";
import { meIdentityChanged } from "./useMe";

const ADMIN = { id: "a".repeat(32), name: "Admin" };

function impersonation(id: string): MeImpersonationDto {
  return {
    id,
    by: ADMIN,
    startedAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-05T11:00:00.000Z",
  };
}

const T1 = "t".repeat(32);
const T2 = "u".repeat(32);

describe("meIdentityChanged", () => {
  it("is no change for the same account under the same impersonation", () => {
    expect(
      meIdentityChanged(
        { id: T1, impersonation: null },
        { id: T1, impersonation: null },
      ),
    ).toBe(false);
    expect(
      meIdentityChanged(
        { id: T1, impersonation: impersonation("imp1") },
        { id: T1, impersonation: impersonation("imp1") },
      ),
    ).toBe(false);
  });

  it("is a change when another tab acts as another account", () => {
    // Tab A acted as T1; the Admin stopped and now acts as T2 elsewhere.
    expect(
      meIdentityChanged(
        { id: T1, impersonation: impersonation("imp1") },
        { id: T2, impersonation: impersonation("imp2") },
      ),
    ).toBe(true);
  });

  it("is a change when the impersonation started, ended or was replaced", () => {
    expect(
      meIdentityChanged(
        { id: T1, impersonation: impersonation("imp1") },
        { id: ADMIN.id, impersonation: null },
      ),
    ).toBe(true);
    expect(
      meIdentityChanged(
        { id: ADMIN.id, impersonation: null },
        { id: T1, impersonation: impersonation("imp1") },
      ),
    ).toBe(true);
    // Same account again, but a new impersonation of it.
    expect(
      meIdentityChanged(
        { id: T1, impersonation: impersonation("imp1") },
        { id: T1, impersonation: impersonation("imp2") },
      ),
    ).toBe(true);
  });

  it("is no change when nothing was known or the session is gone", () => {
    expect(meIdentityChanged(null, { id: T1, impersonation: null })).toBe(
      false,
    );
    expect(meIdentityChanged({ id: T1, impersonation: null }, null)).toBe(
      false,
    );
  });
});

import { describe, expect, it } from "vitest";
import type { MeImpersonationDto } from "~~/shared/types/api";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_IMPLIED_BY,
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { meCan, meGranted, meIdentityChanged } from "./useMe";

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

describe("meCan and meGranted", () => {
  const editor = {
    isAdmin: false,
    permissions: [
      PERMISSION_KEYS.AMENDMENT_MANAGE,
      PERMISSION_KEYS.CONTROL_SHEET_EDIT,
      PERMISSION_KEYS.SEATING_EDIT,
    ],
  };

  it("reads an implied key as held, as the server's rules do", () => {
    for (const [key, implying] of Object.entries(PERMISSION_IMPLIED_BY)) {
      for (const other of implying) {
        const me = { isAdmin: false, permissions: [other] };
        expect(meCan(me, key as PermissionKey), `${other} -> ${key}`).toBe(
          true,
        );
      }
    }
    expect(meCan(editor, PERMISSION_KEYS.AMENDMENT_REVIEW)).toBe(true);
  });

  it("keeps the keys as granted for the grant rules", () => {
    expect(meGranted(editor, PERMISSION_KEYS.AMENDMENT_REVIEW)).toBe(false);
    expect(meGranted(editor, PERMISSION_KEYS.CONTROL_SHEET_VIEW)).toBe(false);
    expect(meGranted(editor, PERMISSION_KEYS.SEATING_VIEW)).toBe(false);
    expect(meGranted(editor, PERMISSION_KEYS.SEATING_EDIT)).toBe(true);
  });

  it("never implies the other way", () => {
    const viewer = {
      isAdmin: false,
      permissions: [PERMISSION_KEYS.SEATING_VIEW],
    };
    expect(meCan(viewer, PERMISSION_KEYS.SEATING_EDIT)).toBe(false);
  });

  it("holds every key for an Admin and none signed out", () => {
    const admin = { isAdmin: true, permissions: [] };
    for (const key of ALL_PERMISSION_KEYS) {
      expect(meCan(admin, key), key).toBe(true);
      expect(meGranted(admin, key), key).toBe(true);
      expect(meCan(null, key), key).toBe(false);
      expect(meGranted(null, key), key).toBe(false);
    }
  });
});

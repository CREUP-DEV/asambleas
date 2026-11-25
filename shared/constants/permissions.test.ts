import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_KEYS,
  CONTROL_SHEET_READER_KEYS,
  PERMISSION_IMPLIED_BY,
  PERMISSION_KEYS,
  holdsPermission,
  readsControlSheet,
  type PermissionKey,
} from "./permissions";

/** A check over exactly these keys, as Actor.can and useMe().can do. */
function only(...keys: PermissionKey[]) {
  return (key: PermissionKey) => keys.includes(key);
}

describe("holdsPermission", () => {
  it("holds a key granted as such", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      expect(holdsPermission(only(key), key), key).toBe(true);
    }
  });

  it("holds a key through each key that implies it, and only those", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      const implying = PERMISSION_IMPLIED_BY[key] ?? [];
      for (const other of ALL_PERMISSION_KEYS) {
        if (other === key) continue;
        expect(holdsPermission(only(other), key), `${other} -> ${key}`).toBe(
          implying.includes(other),
        );
      }
    }
  });

  it("makes amendment:manage open what amendment:review opens", () => {
    expect(
      holdsPermission(
        only(PERMISSION_KEYS.AMENDMENT_MANAGE),
        PERMISSION_KEYS.AMENDMENT_REVIEW,
      ),
    ).toBe(true);
    // Never the other way round.
    expect(
      holdsPermission(
        only(PERMISSION_KEYS.AMENDMENT_REVIEW),
        PERMISSION_KEYS.AMENDMENT_MANAGE,
      ),
    ).toBe(false);
  });

  it("lets an edit key read, never a view key edit", () => {
    expect(
      holdsPermission(
        only(PERMISSION_KEYS.CONTROL_SHEET_EDIT),
        PERMISSION_KEYS.CONTROL_SHEET_VIEW,
      ),
    ).toBe(true);
    expect(
      holdsPermission(
        only(PERMISSION_KEYS.SEATING_EDIT),
        PERMISSION_KEYS.SEATING_VIEW,
      ),
    ).toBe(true);
    expect(
      holdsPermission(
        only(PERMISSION_KEYS.CONTROL_SHEET_VIEW),
        PERMISSION_KEYS.CONTROL_SHEET_EDIT,
      ),
    ).toBe(false);
    expect(
      holdsPermission(
        only(PERMISSION_KEYS.SEATING_VIEW),
        PERMISSION_KEYS.SEATING_EDIT,
      ),
    ).toBe(false);
  });

  it("only names catalog keys, and never a key implying itself", () => {
    for (const [key, implying] of Object.entries(PERMISSION_IMPLIED_BY)) {
      expect(ALL_PERMISSION_KEYS).toContain(key);
      for (const other of implying ?? []) {
        expect(ALL_PERMISSION_KEYS).toContain(other);
        expect(other).not.toBe(key);
      }
    }
  });
});

describe("readsControlSheet", () => {
  it("lets in each of its four keys alone", () => {
    expect([...CONTROL_SHEET_READER_KEYS].sort()).toEqual(
      [
        PERMISSION_KEYS.CONTROL_SHEET_VIEW,
        PERMISSION_KEYS.CONTROL_SHEET_EDIT,
        PERMISSION_KEYS.SESSION_RECORD_SPEAKERS,
        PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT,
      ].sort(),
    );
    for (const key of CONTROL_SHEET_READER_KEYS) {
      expect(readsControlSheet(only(key)), key).toBe(true);
    }
  });

  it("keeps out every other key", () => {
    for (const key of ALL_PERMISSION_KEYS) {
      if (CONTROL_SHEET_READER_KEYS.includes(key)) continue;
      expect(readsControlSheet(only(key)), key).toBe(false);
    }
    expect(readsControlSheet(only())).toBe(false);
  });

  it("lets in an Admin, whose check holds every key", () => {
    expect(readsControlSheet(() => true)).toBe(true);
  });
});

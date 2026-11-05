import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "../../constants/permissions";
import {
  normalizePermissionKeys,
  unknownPermissionKeys,
  userPermissionsBodySchema,
} from "./permissions";

describe("userPermissionsBodySchema", () => {
  it("accepts a list of keys, empty included", () => {
    expect(
      userPermissionsBodySchema.safeParse({
        permissions: [PERMISSION_KEYS.SESSION_MODERATE],
      }).success,
    ).toBe(true);
    expect(
      userPermissionsBodySchema.safeParse({ permissions: [] }).success,
    ).toBe(true);
  });

  it("refuses a malformed body", () => {
    expect(userPermissionsBodySchema.safeParse({}).success).toBe(false);
    expect(
      userPermissionsBodySchema.safeParse({ permissions: "member:manage" })
        .success,
    ).toBe(false);
    expect(
      userPermissionsBodySchema.safeParse({ permissions: [""] }).success,
    ).toBe(false);
  });
});

describe("unknownPermissionKeys", () => {
  it("reports keys outside the catalog once", () => {
    expect(
      unknownPermissionKeys([
        PERMISSION_KEYS.MEMBER_MANAGE,
        "made:up",
        "made:up",
      ]),
    ).toEqual(["made:up"]);
    expect(unknownPermissionKeys([PERMISSION_KEYS.MEMBER_MANAGE])).toEqual([]);
  });
});

describe("normalizePermissionKeys", () => {
  it("keeps catalog order and drops duplicates", () => {
    expect(
      normalizePermissionKeys([
        PERMISSION_KEYS.MEMBER_MANAGE,
        PERMISSION_KEYS.ASSEMBLY_CREATE,
        PERMISSION_KEYS.MEMBER_MANAGE,
      ]),
    ).toEqual([PERMISSION_KEYS.ASSEMBLY_CREATE, PERMISSION_KEYS.MEMBER_MANAGE]);
  });
});

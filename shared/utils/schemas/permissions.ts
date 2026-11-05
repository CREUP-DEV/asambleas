import { z } from "zod/v4";
import {
  ALL_PERMISSION_KEYS,
  type PermissionKey,
} from "../../constants/permissions";

/**
 * PUT /api/admin/users/[id]/permissions: the permissions granted to one user
 * on top of their role, as the full set (an empty list removes every grant).
 * The shape is checked here (400 when malformed); keys outside the catalog
 * are reported by `unknownPermissionKeys` and refused with 422, never
 * ignored.
 */
export const userPermissionsBodySchema = z.object({
  permissions: z
    .array(z.string().trim().min(1).max(100))
    .max(ALL_PERMISSION_KEYS.length * 2),
});

/** Keys of `keys` that are not permission keys, without duplicates. */
export function unknownPermissionKeys(keys: readonly string[]): string[] {
  const known = new Set<string>(ALL_PERMISSION_KEYS);
  return [...new Set(keys.filter((key) => !known.has(key)))];
}

/** The requested keys in catalog order, without duplicates. */
export function normalizePermissionKeys(
  keys: readonly string[],
): PermissionKey[] {
  const requested = new Set(keys);
  return ALL_PERMISSION_KEYS.filter((key) => requested.has(key));
}

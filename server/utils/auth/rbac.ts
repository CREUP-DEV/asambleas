import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { rolePermissions, permissions, userPermissions } from "../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import {
  getAuthUserWithRole,
  requireAuth,
  type AuthEventContext,
  type AuthSession,
} from "./requireAuth";

interface CacheEntry {
  permissions: PermissionKey[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 50;
const USER_CACHE_MAX_ENTRIES = 500;
/** Role id -> the role's permissions. */
const permissionCache = new Map<string, CacheEntry>();
/** User id -> permissions granted to that user on top of the role. */
const userPermissionCache = new Map<string, CacheEntry>();

function pruneCache(cache: Map<string, CacheEntry>, maxEntries: number) {
  if (cache.size <= maxEntries) {
    return;
  }

  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }

  if (cache.size > maxEntries) {
    const oldest = [...cache.entries()].sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    const toRemove = oldest.slice(0, cache.size - maxEntries);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
  }
}

/** Permissions of a role (role_permissions). See getEffectivePermissions for a user's. */
export async function getUserPermissions(
  roleId: string,
): Promise<PermissionKey[]> {
  const now = Date.now();
  const cached = permissionCache.get(roleId);

  if (cached && cached.expiresAt > now) {
    return cached.permissions;
  }

  const rows = await db
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  const keys = rows.map((r) => r.key as PermissionKey);

  permissionCache.set(roleId, {
    permissions: keys,
    expiresAt: now + CACHE_TTL_MS,
  });

  pruneCache(permissionCache, CACHE_MAX_ENTRIES);
  return keys;
}

/** Permissions granted to one user on top of their role (user_permissions). */
export async function getUserExtraPermissions(
  userId: string,
): Promise<PermissionKey[]> {
  const now = Date.now();
  const cached = userPermissionCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.permissions;
  }

  const rows = await db
    .select({ key: permissions.key })
    .from(userPermissions)
    .innerJoin(permissions, eq(userPermissions.permissionId, permissions.id))
    .where(eq(userPermissions.userId, userId));
  const keys = rows.map((row) => row.key as PermissionKey);

  userPermissionCache.set(userId, {
    permissions: keys,
    expiresAt: now + CACHE_TTL_MS,
  });
  pruneCache(userPermissionCache, USER_CACHE_MAX_ENTRIES);
  return keys;
}

/**
 * A user's permissions: every key for Admin, otherwise the role's
 * permissions plus those granted to the user (mergePermissions). A user
 * without a role keeps only their own grants.
 */
export async function getEffectivePermissions(user: {
  id: string;
  role: { id: string; name: string } | null;
}): Promise<PermissionKey[]> {
  if (isAdmin(user.role?.name)) return [...ALL_PERMISSION_KEYS];
  const [rolePermissionKeys, extra] = await Promise.all([
    user.role ? getUserPermissions(user.role.id) : Promise.resolve([]),
    getUserExtraPermissions(user.id),
  ]);
  return mergePermissions(rolePermissionKeys, extra);
}

/**
 * Role permissions plus a user's own grants, without duplicates and in the
 * catalog order (ALL_PERMISSION_KEYS). Keys that are not in the catalog
 * (a removed permission still in the database) are dropped.
 */
export function mergePermissions(
  rolePermissionKeys: readonly string[],
  extra: readonly string[],
): PermissionKey[] {
  const keys = new Set<string>([...rolePermissionKeys, ...extra]);
  return ALL_PERMISSION_KEYS.filter((key) => keys.has(key));
}

export function invalidatePermissionCache(roleId: string) {
  permissionCache.delete(roleId);
}

export function invalidateUserPermissionCache(userId: string) {
  userPermissionCache.delete(userId);
}

export function clearPermissionCache() {
  permissionCache.clear();
  userPermissionCache.clear();
}

export function isAdmin(roleName: string | null | undefined): boolean {
  return roleName === SYSTEM_ROLES.ADMIN;
}

async function resolveSessionWithRole(event: H3Event) {
  const session = await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  return { session, user };
}

export async function attachAuthContext(event: H3Event): Promise<AuthSession> {
  const session = await requireAuth(event);
  const user = await getAuthUserWithRole(event);
  const context = event.context as AuthEventContext;

  context.permissions = user ? await getEffectivePermissions(user) : [];

  return session;
}

export async function requirePermission(
  event: H3Event,
  permissionKey: PermissionKey,
): Promise<AuthSession> {
  const { session, user } = await resolveSessionWithRole(event);

  if (!user) {
    throw createError({
      statusCode: 403,
      message: "Sin rol asignado",
    });
  }

  if (isAdmin(user.role?.name)) {
    return session;
  }

  const effective = await getEffectivePermissions(user);

  if (!effective.includes(permissionKey)) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para realizar esta acción",
    });
  }

  return session;
}

export async function hasPermission(
  event: H3Event,
  permissionKey: PermissionKey,
): Promise<boolean> {
  try {
    await requirePermission(event, permissionKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Permissions that open the admin section (/api/admin): users, their roles,
 * member links and grants need user:manage_roles; roles and the permission
 * catalog need role:manage_permissions. The association's Secretaría and
 * Presidencia hold both; Admin has every key.
 */
export const ADMIN_SECTION_PERMISSIONS: readonly PermissionKey[] = [
  PERMISSION_KEYS.USER_MANAGE_ROLES,
  PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
];

/** Whether `permissions` include at least one of `keys`. */
export function hasAnyPermission(
  permissions: readonly string[],
  keys: readonly PermissionKey[],
): boolean {
  return keys.some((key) => permissions.includes(key));
}

/** What requireAnyPermission returns: who is acting and what they hold. */
export interface AdminCaller {
  session: AuthSession;
  /** The caller is an Admin: the only one who may touch the Admin role. */
  admin: boolean;
  user: { id: string; role: { id: string; name: string } | null };
  /** The caller's effective permissions (every key for an Admin). */
  permissions: PermissionKey[];
}

/**
 * Requires at least one of these permissions (Admin passes through the
 * bypass). Returns the session, whether the user is an Admin (for the
 * changes only an Admin may make: giving or taking the Admin role, its own
 * account and role) and the caller's permissions (adminGrantViolation).
 */
export async function requireAnyPermission(
  event: H3Event,
  keys: readonly PermissionKey[],
): Promise<AdminCaller> {
  const { session, user } = await resolveSessionWithRole(event);

  if (!user) {
    throw createError({
      statusCode: 403,
      message: "Sin rol asignado",
    });
  }

  const caller = { id: user.id, role: user.role ?? null };
  if (isAdmin(user.role?.name)) {
    return {
      session,
      admin: true,
      user: caller,
      permissions: [...ALL_PERMISSION_KEYS],
    };
  }

  const permissions = await getEffectivePermissions(user);
  if (!hasAnyPermission(permissions, keys)) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para realizar esta acción",
    });
  }

  return { session, admin: false, user: caller, permissions };
}

/** Messages for adminGrantViolation. */
export const ADMIN_GRANT_MESSAGES = {
  own_account:
    "Solo un Admin puede cambiar los permisos o el miembro de su propia cuenta",
  own_role: "No puedes cambiar los permisos de tu propio rol",
  not_held: "Solo puedes dar o quitar permisos que tú también tienes",
} as const;

/**
 * Why a non-Admin may not make this change in the admin section, or null
 * when it may (docs/api.md, "Admin section"). Holding user:manage_roles or
 * role:manage_permissions must not let anyone raise their own access:
 * - `own_account`: the grants and member link of one's own account;
 * - `own_role`: the permissions of the role one holds;
 * - `not_held`: adding or removing a key the caller does not hold itself
 *   (only the keys that change count, so saving an unchanged list that
 *   contains such a key is fine).
 * An Admin passes every check: it holds every key anyway.
 */
export function adminGrantViolation(input: {
  admin: boolean;
  callerPermissions: readonly string[];
  ownTarget: boolean;
  target: "account" | "role";
  before?: readonly string[];
  after?: readonly string[];
}): keyof typeof ADMIN_GRANT_MESSAGES | null {
  if (input.admin) return null;
  if (input.ownTarget) {
    return input.target === "account" ? "own_account" : "own_role";
  }
  if (input.before && input.after) {
    const before = new Set(input.before);
    const after = new Set(input.after);
    const changed = [
      ...input.after.filter((key) => !before.has(key)),
      ...input.before.filter((key) => !after.has(key)),
    ];
    if (changed.some((key) => !input.callerPermissions.includes(key))) {
      return "not_held";
    }
  }
  return null;
}

export async function requireAdmin(event: H3Event): Promise<AuthSession> {
  const { session, user } = await resolveSessionWithRole(event);

  if (!isAdmin(user?.role?.name)) {
    throw createError({
      statusCode: 403,
      message: "Acceso restringido a administradores",
    });
  }

  return session;
}

import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { rolePermissions, permissions, userPermissions } from "../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
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

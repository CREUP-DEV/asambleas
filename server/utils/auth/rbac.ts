import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { rolePermissions, permissions } from "../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { PermissionKey } from "~~/shared/constants/permissions";
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
const permissionCache = new Map<string, CacheEntry>();

function pruneCache() {
  if (permissionCache.size <= CACHE_MAX_ENTRIES) {
    return;
  }

  const now = Date.now();
  for (const [key, entry] of permissionCache) {
    if (entry.expiresAt <= now) {
      permissionCache.delete(key);
    }
  }

  if (permissionCache.size > CACHE_MAX_ENTRIES) {
    const oldest = [...permissionCache.entries()].sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    const toRemove = oldest.slice(0, permissionCache.size - CACHE_MAX_ENTRIES);
    for (const [key] of toRemove) {
      permissionCache.delete(key);
    }
  }
}

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

  pruneCache();
  return keys;
}

export function invalidatePermissionCache(roleId: string) {
  permissionCache.delete(roleId);
}

export function clearPermissionCache() {
  permissionCache.clear();
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

  if (!user?.role) {
    context.permissions = [];
    return session;
  }

  context.permissions = isAdmin(user.role.name)
    ? []
    : await getUserPermissions(user.role.id);

  return session;
}

export async function requirePermission(
  event: H3Event,
  permissionKey: PermissionKey,
): Promise<AuthSession> {
  const { session, user } = await resolveSessionWithRole(event);

  if (!user?.role) {
    throw createError({
      statusCode: 403,
      message: "Sin rol asignado",
    });
  }

  if (isAdmin(user.role.name)) {
    return session;
  }

  const userPermissions = await getUserPermissions(user.role.id);

  if (!userPermissions.includes(permissionKey)) {
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

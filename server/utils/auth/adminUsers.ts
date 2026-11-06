import { eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../db";
import { permissions, userPermissions, users } from "../../db/schema";
import {
  ALL_PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";

/**
 * The user row the admin users list returns (GET /api/admin/users), shared by
 * the endpoints that change one user so the client can replace it in place
 * (AdminUserDto). `member` is the member the account acts for
 * (users.memberId); `extraPermissions` are the permissions granted to the
 * user on top of their role (user_permissions), in catalog order;
 * `accessRevokedAt` and `accessRevokedReason` say when and why the account
 * lost access to the platform (null while it has access).
 */
export const ADMIN_USER_COLUMNS = {
  id: true,
  name: true,
  email: true,
  image: true,
  roleId: true,
  memberId: true,
  externalRole: true,
  externalName: true,
  externalInitials: true,
  university: true,
  lastRoleSyncAt: true,
  accessRevokedAt: true,
  accessRevokedReason: true,
  createdAt: true,
} as const;

/**
 * Which accounts GET /api/admin/users lists: every one (`all`, the default)
 * or only those that lost access to the platform (`revoked`).
 */
export const ADMIN_USERS_ACCESS_FILTERS = ["all", "revoked"] as const;
export type AdminUsersAccessFilter =
  (typeof ADMIN_USERS_ACCESS_FILTERS)[number];

/** The query of GET /api/admin/users: a page and the access filter. */
export const adminUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  access: z.enum(ADMIN_USERS_ACCESS_FILTERS).default("all"),
});

/** The `where` of the users list for an access filter; none for `all`. */
export function adminUsersAccessWhere(
  access: AdminUsersAccessFilter,
): SQL | undefined {
  return access === "revoked" ? isNotNull(users.accessRevokedAt) : undefined;
}

export const ADMIN_USER_RELATIONS = {
  role: { columns: { id: true, name: true } },
  member: { columns: { id: true, acronym: true, name: true, kind: true } },
} as const;

function findAdminUser(userId: string) {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: ADMIN_USER_COLUMNS,
    with: ADMIN_USER_RELATIONS,
  });
}

type AdminUserBase = NonNullable<Awaited<ReturnType<typeof findAdminUser>>>;

export type AdminUserRow = AdminUserBase & {
  extraPermissions: PermissionKey[];
};

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Permissions granted per user, for these users, in catalog order. */
export async function loadExtraPermissions(
  userIds: string[],
  executor: Executor = db,
): Promise<Map<string, PermissionKey[]>> {
  const result = new Map<string, PermissionKey[]>();
  if (userIds.length === 0) return result;
  const rows = await executor
    .select({ userId: userPermissions.userId, key: permissions.key })
    .from(userPermissions)
    .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
    .where(inArray(userPermissions.userId, userIds));
  const keysByUser = new Map<string, Set<string>>();
  for (const row of rows) {
    const keys = keysByUser.get(row.userId) ?? new Set<string>();
    keys.add(row.key);
    keysByUser.set(row.userId, keys);
  }
  for (const [userId, keys] of keysByUser) {
    result.set(
      userId,
      ALL_PERMISSION_KEYS.filter((key) => keys.has(key)),
    );
  }
  return result;
}

/** Adds `extraPermissions` to rows read with ADMIN_USER_COLUMNS. */
export async function withExtraPermissions<T extends { id: string }>(
  rows: T[],
): Promise<(T & { extraPermissions: PermissionKey[] })[]> {
  const extra = await loadExtraPermissions(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    extraPermissions: extra.get(row.id) ?? [],
  }));
}

export async function loadAdminUser(
  userId: string,
): Promise<AdminUserRow | undefined> {
  const row = await findAdminUser(userId);
  if (!row) return undefined;
  const [withExtra] = await withExtraPermissions([row]);
  return withExtra;
}

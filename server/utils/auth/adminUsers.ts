import { isOnline } from "../live/online";
import {
  and,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../db";
import { permissions, userPermissions, users } from "../../db/schema";
import {
  ALL_PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import type { MemberRef } from "~~/shared/types/api";
import { accountAvatarText } from "~~/shared/utils/accountAvatar";
import { toMemberRef } from "../members/dto";

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
  universityAcronym: true,
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

/**
 * The query of GET /api/admin/users: a page, the access filter and a search
 * (`q`: part of the name, the email, the intranet initials or the acronym or
 * name of the member the account acts for; blank is none).
 */
export const adminUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  access: z.enum(ADMIN_USERS_ACCESS_FILTERS).default("all"),
  q: z
    .string()
    .max(100)
    .optional()
    .transform((value) => value?.trim() || undefined),
});

/** The `where` of the users list for an access filter; none for `all`. */
export function adminUsersAccessWhere(
  access: AdminUsersAccessFilter,
): SQL | undefined {
  return access === "revoked" ? isNotNull(users.accessRevokedAt) : undefined;
}

/** The text anywhere, with `%`, `_` and `\` matching themselves. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The `where` of a search in the users list: the text anywhere in the name,
 * the email or the intranet initials, or in the acronym or the name of the
 * member the account acts for. None for an empty search.
 */
export function adminUsersSearchWhere(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const pattern = likePattern(q);
  return or(
    ilike(users.name, pattern),
    ilike(users.email, pattern),
    ilike(users.externalInitials, pattern),
    // Written out: the relational query (db.query.users.findMany) rewrites
    // every column in its `where` to the users table, members' included.
    sql`${users.memberId} in (select m.id from members m where m.acronym ilike ${pattern} or m.name ilike ${pattern})`,
  );
}

/** Both filters of the users list together. */
export function adminUsersWhere(
  access: AdminUsersAccessFilter,
  q: string | undefined,
): SQL | undefined {
  return and(adminUsersAccessWhere(access), adminUsersSearchWhere(q));
}

export const ADMIN_USER_RELATIONS = {
  role: { columns: { id: true, name: true } },
  member: {
    columns: {
      id: true,
      acronym: true,
      name: true,
      kind: true,
      universityAcronym: true,
    },
  },
} as const;

function findAdminUser(userId: string) {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: ADMIN_USER_COLUMNS,
    with: ADMIN_USER_RELATIONS,
  });
}

type AdminUserBase = NonNullable<Awaited<ReturnType<typeof findAdminUser>>>;

export type AdminUserRow = Awaited<
  ReturnType<typeof withExtraPermissions<AdminUserBase>>
>[number];

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

/**
 * Rows read with ADMIN_USER_COLUMNS and ADMIN_USER_RELATIONS as the client
 * reads them: `extraPermissions`, `online` and `avatarText` added, the
 * university acronyms folded into `avatarText`.
 */
export async function withExtraPermissions<
  T extends {
    id: string;
    universityAcronym: string | null;
    member: (MemberRef & { universityAcronym: string | null }) | null;
  },
>(
  rows: T[],
): Promise<
  (Omit<T, "universityAcronym" | "member"> & {
    member: MemberRef | null;
    avatarText: string | null;
    extraPermissions: PermissionKey[];
    online: boolean;
  })[]
> {
  const extra = await loadExtraPermissions(rows.map((row) => row.id));
  const now = Date.now();
  return rows.map(({ universityAcronym, member, ...row }) => ({
    ...row,
    member: member ? toMemberRef(member) : null,
    avatarText: accountAvatarText({ universityAcronym }, member),
    extraPermissions: extra.get(row.id) ?? [],
    // Whether it used the platform lately (server/utils/live/online.ts).
    online: isOnline(row.id, now),
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

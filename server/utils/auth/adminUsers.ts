import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";

/**
 * The user row the admin users list returns (GET /api/admin/users), shared by
 * the endpoints that change one user so the client can replace it in place.
 * `member` is the member the account acts for (users.memberId).
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
  createdAt: true,
} as const;

export const ADMIN_USER_RELATIONS = {
  role: { columns: { id: true, name: true } },
  member: { columns: { id: true, acronym: true, name: true, kind: true } },
} as const;

export function loadAdminUser(userId: string) {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: ADMIN_USER_COLUMNS,
    with: ADMIN_USER_RELATIONS,
  });
}

export type AdminUserRow = NonNullable<
  Awaited<ReturnType<typeof loadAdminUser>>
>;

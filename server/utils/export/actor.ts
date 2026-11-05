import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { getEffectivePermissions, isAdmin } from "../auth/rbac";
import type { Actor } from "../domain/actor";
import type { PermissionKey } from "~~/shared/constants/permissions";

/**
 * The export worker has no request, so it rebuilds the requester as an
 * `Actor` (same shape as `requireActor`). Visibility is evaluated when the
 * PDF is generated, with the requester's current role and member.
 */
export async function loadExportActor(userId: string): Promise<Actor | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      roleId: true,
      externalRole: true,
      externalName: true,
      externalInitials: true,
      university: true,
      memberId: true,
      lastRoleSyncAt: true,
    },
    with: {
      role: { columns: { id: true, name: true } },
    },
  });
  if (!user) return null;

  const admin = isAdmin(user.role?.name);
  // The same union of role and per-user permissions as requireActor.
  const permissions: PermissionKey[] = await getEffectivePermissions(user);

  return {
    user,
    memberId: user.memberId,
    isAdmin: admin,
    permissions,
    can: (key) => admin || permissions.includes(key),
  };
}

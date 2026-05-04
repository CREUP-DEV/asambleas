import { defineEventHandler, setHeader } from "h3";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../utils/auth/requireAuth";
import { getUserPermissions, isAdmin } from "../../utils/auth/rbac";
import { db } from "../../db";
import { users } from "../../db/schema";
import { ALL_PERMISSION_KEYS } from "~~/shared/constants/permissions";

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event);
  setHeader(event, "cache-control", "no-store");

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { roleId: true },
    with: {
      role: { columns: { name: true } },
    },
  });

  if (!user?.role) {
    return { permissions: [], role: null };
  }

  if (isAdmin(user.role.name)) {
    return {
      permissions: ALL_PERMISSION_KEYS,
      role: user.role.name,
    };
  }

  const permissions = user.roleId ? await getUserPermissions(user.roleId) : [];

  return {
    permissions,
    role: user.role.name,
  };
});

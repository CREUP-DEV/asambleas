import { defineEventHandler, createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { roles, rolePermissions, permissions } from "../../../../db/schema";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireAnyPermission } from "../../../../utils/auth/rbac";
import { validateCuid } from "../../../../utils/validation";

/**
 * What a role grants. Read by whoever manages roles and by whoever assigns
 * them (to show what a user gets on top of its own grants).
 */
export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, [
    PERMISSION_KEYS.USER_MANAGE_ROLES,
    PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
  ]);
  const roleId = validateCuid(getRouterParam(event, "id"));

  const role = await db.query.roles.findFirst({
    where: eq(roles.id, roleId),
    columns: { id: true, name: true },
  });

  if (!role) {
    throw createError({ statusCode: 404, message: "Rol no encontrado" });
  }

  const assigned = await db
    .select({ key: permissions.key, id: permissions.id })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  return {
    role,
    permissions: assigned.map((p) => p.key),
    permissionIds: assigned.map((p) => p.id),
  };
});

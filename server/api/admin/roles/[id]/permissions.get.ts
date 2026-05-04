import { defineEventHandler, createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { roles, rolePermissions, permissions } from "../../../../db/schema";

export default defineEventHandler(async (event) => {
  const roleId = getRouterParam(event, "id");
  if (!roleId) {
    throw createError({ statusCode: 400, message: "ID requerido" });
  }

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

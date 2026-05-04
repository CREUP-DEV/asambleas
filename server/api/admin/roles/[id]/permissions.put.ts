import { defineEventHandler, readBody, createError } from "h3";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../../db";
import { roles, rolePermissions, permissions } from "../../../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { ALL_PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  invalidatePermissionCache,
  requireAdmin,
} from "../../../../utils/auth/rbac";
import { validateCuid } from "../../../../utils/validation";

const bodySchema = z.object({
  permissionKeys: z.array(z.enum(ALL_PERMISSION_KEYS)),
});

export default defineEventHandler(async (event) => {
  await requireAdmin(event);
  const roleId = validateCuid(getRouterParam(event, "id"));

  const body = await readBody(event);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "permissionKeys debe ser un array de strings",
    });
  }

  const role = await db.query.roles.findFirst({
    where: eq(roles.id, roleId),
    columns: { id: true, name: true },
  });

  if (!role) {
    throw createError({ statusCode: 404, message: "Rol no encontrado" });
  }

  if (role.name === SYSTEM_ROLES.ADMIN) {
    throw createError({
      statusCode: 400,
      message: "No se pueden modificar permisos del rol Admin",
    });
  }

  const targetPermissions =
    parsed.data.permissionKeys.length > 0
      ? await db.query.permissions.findMany({
          where: inArray(permissions.key, parsed.data.permissionKeys),
          columns: { id: true, key: true },
        })
      : [];

  const targetPermissionIds = new Set(targetPermissions.map((p) => p.id));

  await db.transaction(async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

    if (targetPermissionIds.size > 0) {
      await tx.insert(rolePermissions).values(
        [...targetPermissionIds].map((permissionId) => ({
          roleId,
          permissionId,
        })),
      );
    }
  });

  invalidatePermissionCache(roleId);

  return {
    success: true,
    permissions: targetPermissions.map((p) => p.key),
  };
});

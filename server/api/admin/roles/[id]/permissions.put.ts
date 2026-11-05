import { defineEventHandler, readBody, createError } from "h3";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../../db";
import {
  roles,
  rolePermissions,
  permissions,
  auditLog,
} from "../../../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_KEYS,
} from "~~/shared/constants/permissions";
import {
  ADMIN_GRANT_MESSAGES,
  adminGrantViolation,
  invalidatePermissionCache,
  requireAnyPermission,
  touchesLeadershipRole,
} from "../../../../utils/auth/rbac";
import { validateCuid } from "../../../../utils/validation";
import type { AuthEventContext } from "../../../../utils/auth/requireAuth";

const bodySchema = z.object({
  permissionKeys: z.array(z.enum(ALL_PERMISSION_KEYS)),
});

/**
 * Sets the permissions of a role (role:manage_permissions). Only an Admin
 * may touch the Admin role, which holds every permission anyway (403 for
 * anyone else, 400 for an Admin). A non-Admin may not take
 * user:manage_roles or role:manage_permissions away from the role it holds
 * (it would lock itself, and everyone with that role, out of the admin
 * section), nor add or remove a key it does not hold itself (403,
 * adminGrantViolation): otherwise it could raise its own access.
 */
export default defineEventHandler(async (event) => {
  const caller = await requireAnyPermission(event, [
    PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
  ]);
  const { admin } = caller;
  const roleId = validateCuid(getRouterParam(event, "id"));
  const deny = (input: { before?: string[]; after?: string[] }) => {
    const violation = adminGrantViolation({
      admin,
      callerPermissions: caller.permissions,
      ownTarget: caller.user.role?.id === roleId,
      target: "role",
      ...input,
    });
    if (violation) {
      throw createError({
        statusCode: 403,
        message: ADMIN_GRANT_MESSAGES[violation],
      });
    }
  };

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
    throw createError(
      admin
        ? {
            statusCode: 400,
            message: "No se pueden modificar permisos del rol Admin",
          }
        : {
            statusCode: 403,
            message: "Solo un Admin puede cambiar los permisos del rol Admin",
          },
    );
  }
  if (touchesLeadershipRole(admin, [role.name])) {
    throw createError({
      statusCode: 403,
      message: ADMIN_GRANT_MESSAGES.leadership,
    });
  }
  deny({});

  const targetPermissions =
    parsed.data.permissionKeys.length > 0
      ? await db.query.permissions.findMany({
          where: inArray(permissions.key, parsed.data.permissionKeys),
          columns: { id: true, key: true },
        })
      : [];

  const targetPermissionIds = new Set(targetPermissions.map((p) => p.id));

  const context = event.context as AuthEventContext;

  await db.transaction(async (tx) => {
    const previousPermissions = await tx.query.rolePermissions.findMany({
      where: eq(rolePermissions.roleId, roleId),
      with: { permission: { columns: { key: true } } },
    });
    const previousPermissionKeys = previousPermissions
      .map((rp) => rp.permission?.key)
      .filter((key): key is string => Boolean(key));
    deny({
      before: previousPermissionKeys,
      after: parsed.data.permissionKeys,
    });

    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));

    if (targetPermissionIds.size > 0) {
      await tx.insert(rolePermissions).values(
        [...targetPermissionIds].map((permissionId) => ({
          roleId,
          permissionId,
        })),
      );
    }

    await tx.insert(auditLog).values({
      actorUserId: context.session?.user.id ?? null,
      action: "permissions.set",
      targetType: "role",
      targetId: roleId,
      before: { permissions: previousPermissionKeys },
      after: { permissions: parsed.data.permissionKeys },
    });
  });

  invalidatePermissionCache(roleId);

  return {
    success: true,
    permissions: targetPermissions.map((p) => p.key),
  };
});

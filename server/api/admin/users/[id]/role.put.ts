import { defineEventHandler, readBody, createError } from "h3";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../../db";
import { users, roles, auditLog } from "../../../../db/schema";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ADMIN_GRANT_MESSAGES,
  adminGrantViolation,
  getUserPermissions,
  requireAnyPermission,
} from "../../../../utils/auth/rbac";
import { isDefaultCuid, validateAuthId } from "../../../../utils/validation";

import type { AuthEventContext } from "../../../../utils/auth/requireAuth";

const bodySchema = z.object({
  roleId: z.string().refine(isDefaultCuid),
});

/**
 * Changes a user's role (user:manage_roles). Only an Admin gives or takes
 * the Admin role (403 otherwise), and nobody changes their own role. A
 * non-Admin may not give or take, through the role, a permission it does
 * not hold itself (403, adminGrantViolation).
 */
export default defineEventHandler(async (event) => {
  const { admin, permissions } = await requireAnyPermission(event, [
    PERMISSION_KEYS.USER_MANAGE_ROLES,
  ]);
  const userId = validateAuthId(getRouterParam(event, "id"));

  const body = await readBody(event);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "roleId requerido" });
  }

  const targetRole = await db.query.roles.findFirst({
    where: eq(roles.id, parsed.data.roleId),
    columns: { id: true, name: true },
  });

  if (!targetRole) {
    throw createError({ statusCode: 404, message: "Rol no encontrado" });
  }

  const targetUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, email: true, roleId: true },
    with: { role: { columns: { name: true } } },
  });

  if (!targetUser) {
    throw createError({ statusCode: 404, message: "Usuario no encontrado" });
  }

  if (
    !admin &&
    (targetRole.name === SYSTEM_ROLES.ADMIN ||
      targetUser.role?.name === SYSTEM_ROLES.ADMIN)
  ) {
    throw createError({
      statusCode: 403,
      message: "Solo un Admin puede dar o quitar el rol Admin",
    });
  }

  const context = event.context as AuthEventContext;
  if (targetUser.id === context.session?.user.id) {
    throw createError({
      statusCode: 400,
      message: "No puedes cambiar tu propio rol",
    });
  }

  if (!admin && targetUser.roleId !== targetRole.id) {
    const violation = adminGrantViolation({
      admin,
      callerPermissions: permissions,
      ownTarget: false,
      target: "account",
      before: targetUser.roleId
        ? await getUserPermissions(targetUser.roleId)
        : [],
      after: await getUserPermissions(targetRole.id),
    });
    if (violation) {
      throw createError({
        statusCode: 403,
        message: ADMIN_GRANT_MESSAGES[violation],
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ roleId: parsed.data.roleId })
      .where(eq(users.id, userId));

    await tx.insert(auditLog).values({
      actorUserId: context.session?.user.id ?? null,
      action: "role.assign",
      targetType: "user",
      targetId: userId,
      before: {
        roleId: targetUser.roleId ?? null,
        roleName: targetUser.role?.name ?? null,
      },
      after: { roleId: parsed.data.roleId, roleName: targetRole.name },
    });
  });

  return {
    success: true,
    roleId: parsed.data.roleId,
    roleName: targetRole.name,
  };
});

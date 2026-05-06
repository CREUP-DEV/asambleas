import { defineEventHandler, readBody, createError } from "h3";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../../db";
import { users, roles, auditLog } from "../../../../db/schema";
import { requireAdmin } from "../../../../utils/auth/rbac";
import { isDefaultCuid, validateAuthId } from "../../../../utils/validation";

import type { AuthEventContext } from "../../../../utils/auth/requireAuth";

const bodySchema = z.object({
  roleId: z.string().refine(isDefaultCuid),
});

export default defineEventHandler(async (event) => {
  await requireAdmin(event);
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

  const context = event.context as AuthEventContext;
  if (targetUser.id === context.session?.user.id) {
    throw createError({
      statusCode: 400,
      message: "No puedes cambiar tu propio rol",
    });
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

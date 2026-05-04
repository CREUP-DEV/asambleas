import { defineEventHandler, readBody, createError } from "h3";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../../db";
import { users, roles } from "../../../../db/schema";

import type { AuthEventContext } from "../../../../utils/auth/requireAuth";

const bodySchema = z.object({
  roleId: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, "id");
  if (!userId) {
    throw createError({ statusCode: 400, message: "ID requerido" });
  }

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
    columns: { id: true, email: true },
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

  await db
    .update(users)
    .set({ roleId: parsed.data.roleId })
    .where(eq(users.id, userId));

  return {
    success: true,
    roleId: parsed.data.roleId,
    roleName: targetRole.name,
  };
});

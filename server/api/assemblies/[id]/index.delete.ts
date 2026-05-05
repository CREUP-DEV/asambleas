import { defineEventHandler, createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import { requirePermission } from "../../../utils/auth/rbac";
import { throwMutationError } from "../../../utils/errors";
import { validateCuid } from "../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_MANAGE);

  const id = validateCuid(event.context.params?.id);

  const existing = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, id),
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  if (existing.status !== ASSEMBLY_STATUSES.DRAFT) {
    throw createError({
      statusCode: 409,
      message: "Solo se pueden eliminar asambleas en estado borrador",
    });
  }

  try {
    await db.delete(assemblies).where(eq(assemblies.id, id));
    return { success: true };
  } catch (error) {
    throwMutationError("assemblies.delete", error, event);
  }
});

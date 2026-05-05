import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import { requirePermission } from "../../../utils/auth/rbac";
import { throwMutationError } from "../../../utils/errors";
import { buildOptimisticLockCondition } from "../../../utils/optimisticLock";
import { validateCuid } from "../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  ASSEMBLY_STATUS_TRANSITIONS,
  type AssemblyStatus,
} from "~~/shared/constants/statuses";
import { updateAssemblyStatusSchema } from "~~/shared/utils/schemas/assembly";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_MANAGE);

  const id = validateCuid(event.context.params?.id);

  const body = await readBody(event);
  const parsed = updateAssemblyStatusSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Estado inválido" });
  }

  const { status: newStatus, updatedAt } = parsed.data;

  const existing = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, id),
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const currentStatus = existing.status as AssemblyStatus;
  const validTransitions = ASSEMBLY_STATUS_TRANSITIONS[currentStatus] ?? [];

  if (!validTransitions.includes(newStatus as AssemblyStatus)) {
    throw createError({
      statusCode: 409,
      message: `Transición de estado no permitida: ${currentStatus} → ${newStatus}`,
    });
  }

  try {
    const [updated] = await db
      .update(assemblies)
      .set({ status: newStatus as "draft" | "provisional" | "definitive" })
      .where(
        and(
          eq(assemblies.id, id),
          buildOptimisticLockCondition(assemblies.updatedAt, updatedAt),
        ),
      )
      .returning();

    if (!updated) {
      throw createError({
        statusCode: 409,
        message:
          "La asamblea ha sido modificada por otro usuario. Recarga la página.",
      });
    }

    return updated;
  } catch (error) {
    throwMutationError("assemblies.status.put", error, event);
  }
});

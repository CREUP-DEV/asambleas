import { defineEventHandler, readBody, createError } from "h3";
import { eq, and } from "drizzle-orm";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import { requirePermission } from "../../../utils/auth/rbac";
import { throwMutationError } from "../../../utils/errors";
import { buildOptimisticLockCondition } from "../../../utils/optimisticLock";
import { validateCuid } from "../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { updateAssemblySchema } from "~~/shared/utils/schemas/assembly";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_MANAGE);

  const id = validateCuid(event.context.params?.id);

  const body = await readBody(event);
  const parsed = updateAssemblySchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Datos inválidos" });
  }

  const { updatedAt, ...fields } = parsed.data;

  const existing = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, id),
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const startDate = fields.startDate
    ? new Date(fields.startDate)
    : existing.startDate;
  const endDate = fields.endDate ? new Date(fields.endDate) : existing.endDate;

  if (endDate < startDate) {
    throw createError({
      statusCode: 400,
      message: "La fecha de fin no puede ser anterior a la fecha de inicio",
    });
  }

  try {
    const [updated] = await db
      .update(assemblies)
      .set({
        ...(fields.number !== undefined && { number: fields.number }),
        ...(fields.type !== undefined && {
          type: fields.type as "AGO" | "AGE" | "AGET",
        }),
        ...(fields.startDate !== undefined && { startDate }),
        ...(fields.endDate !== undefined && { endDate }),
        ...(fields.location !== undefined && { location: fields.location }),
      })
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
    throwMutationError("assemblies.put", error, event);
  }
});

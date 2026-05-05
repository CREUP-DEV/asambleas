import { defineEventHandler, readBody, createError } from "h3";
import { assemblies } from "../../db/schema";
import { requirePermission } from "../../utils/auth/rbac";
import { throwMutationError } from "../../utils/errors";
import { runCrudTransaction } from "../../utils/crud";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { createAssemblySchema } from "~~/shared/utils/schemas/assembly";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_CREATE);

  const body = await readBody(event);
  const parsed = createAssemblySchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de asamblea inválidos",
    });
  }

  const { number, type, startDate, endDate, location } = parsed.data;

  if (new Date(endDate) < new Date(startDate)) {
    throw createError({
      statusCode: 400,
      message: "La fecha de fin no puede ser anterior a la fecha de inicio",
    });
  }

  try {
    const assembly = await runCrudTransaction(async (tx) => {
      const [created] = await tx
        .insert(assemblies)
        .values({
          number,
          type: type as "AGO" | "AGE" | "AGET",
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          location,
        })
        .returning();
      return created;
    }, "Error al crear la asamblea");

    return assembly;
  } catch (error) {
    throwMutationError("assemblies.post", error, event);
  }
});

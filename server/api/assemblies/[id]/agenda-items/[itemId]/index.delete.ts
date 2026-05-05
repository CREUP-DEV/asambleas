import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { agendaItems, assemblies } from "../../../../../db/schema";
import { requirePermission } from "../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../utils/errors";
import { validateCuid } from "../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_MANAGE);

  const assemblyId = validateCuid(event.context.params?.id, "Assembly ID");
  const itemId = validateCuid(event.context.params?.itemId, "Item ID");

  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
    columns: { id: true, status: true },
  });

  if (!assembly) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const existing = await db.query.agendaItems.findFirst({
    where: and(
      eq(agendaItems.id, itemId),
      eq(agendaItems.assemblyId, assemblyId),
    ),
    columns: { id: true, parentId: true },
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Punto no encontrado" });
  }

  // Root items cannot be deleted from definitive assemblies
  if (!existing.parentId && assembly.status === ASSEMBLY_STATUSES.DEFINITIVE) {
    throw createError({
      statusCode: 409,
      message: "No se pueden eliminar puntos raíz de una asamblea definitiva",
    });
  }

  try {
    await db
      .delete(agendaItems)
      .where(
        and(eq(agendaItems.id, itemId), eq(agendaItems.assemblyId, assemblyId)),
      );

    return { success: true };
  } catch (error) {
    throwMutationError("agenda-items.delete", error, event);
  }
});

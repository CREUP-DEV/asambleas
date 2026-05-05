import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { agendaItems, assemblies } from "../../../../../db/schema";
import { requirePermission } from "../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../utils/errors";
import { validateCuid } from "../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";
import { reorderAgendaItemsSchema } from "~~/shared/utils/schemas/agendaItem";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_MANAGE);

  const assemblyId = validateCuid(event.context.params?.id, "Assembly ID");
  const routeItemId = validateCuid(event.context.params?.itemId, "Item ID");

  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
    columns: { id: true, status: true },
  });

  if (!assembly) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const body = await readBody(event);
  const parsed = reorderAgendaItemsSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de reordenación inválidos",
    });
  }

  const { items } = parsed.data;

  if (items.length === 0) {
    return { success: true };
  }

  const ids = items.map((i) => i.id);

  for (const id of ids) {
    validateCuid(id, "Item ID");
  }

  if (!ids.includes(routeItemId) || new Set(ids).size !== ids.length) {
    throw createError({
      statusCode: 400,
      message: "Datos de reordenación inválidos",
    });
  }

  const allItems = await db.query.agendaItems.findMany({
    where: eq(agendaItems.assemblyId, assemblyId),
    columns: { id: true, parentId: true, order: true },
  });

  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const existingItems = ids.map((id) => itemById.get(id));

  if (existingItems.some((item) => !item)) {
    throw createError({
      statusCode: 400,
      message: "Algunos puntos no pertenecen a esta asamblea",
    });
  }

  const proposedParentById = new Map(
    allItems.map((item) => [item.id, item.parentId]),
  );

  for (const item of items) {
    if (item.parentId !== undefined) {
      if (
        item.parentId === item.id ||
        (item.parentId && !itemById.has(item.parentId))
      ) {
        throw createError({
          statusCode: 400,
          message: "El punto padre no pertenece a esta asamblea",
        });
      }
      proposedParentById.set(item.id, item.parentId ?? null);
    }
  }

  for (const item of allItems) {
    const seen = new Set<string>();
    let parentId = proposedParentById.get(item.id) ?? null;

    while (parentId) {
      if (seen.has(parentId) || parentId === item.id) {
        throw createError({
          statusCode: 400,
          message: "La reordenación crea un ciclo en el orden del día",
        });
      }
      seen.add(parentId);
      parentId = proposedParentById.get(parentId) ?? null;
    }
  }

  if (assembly.status === ASSEMBLY_STATUSES.DEFINITIVE) {
    const changesRootItems = items.some((item) => {
      const existing = itemById.get(item.id);
      return !existing?.parentId || item.parentId === null;
    });
    if (changesRootItems) {
      throw createError({
        statusCode: 409,
        message:
          "No se pueden reordenar puntos raíz en una asamblea definitiva",
      });
    }
  }

  try {
    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .update(agendaItems)
          .set({
            order: item.order,
            ...(item.parentId !== undefined && {
              parentId: item.parentId ?? null,
            }),
          })
          .where(
            and(
              eq(agendaItems.id, item.id),
              eq(agendaItems.assemblyId, assemblyId),
            ),
          );
      }
    });

    return { success: true };
  } catch (error) {
    throwMutationError("agenda-items.reorder", error, event);
  }
});

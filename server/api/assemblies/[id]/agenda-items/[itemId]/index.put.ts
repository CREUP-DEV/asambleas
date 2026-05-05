import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { agendaItems, assemblies } from "../../../../../db/schema";
import { requirePermission } from "../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../utils/errors";
import { buildOptimisticLockCondition } from "../../../../../utils/optimisticLock";
import { validateCuid } from "../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";
import { updateAgendaItemSchema } from "~~/shared/utils/schemas/agendaItem";

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
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Punto no encontrado" });
  }

  // Root items cannot be edited in definitive assemblies
  if (!existing.parentId && assembly.status === ASSEMBLY_STATUSES.DEFINITIVE) {
    throw createError({
      statusCode: 409,
      message: "No se pueden editar puntos raíz en una asamblea definitiva",
    });
  }

  const body = await readBody(event);
  const parsed = updateAgendaItemSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Datos inválidos" });
  }

  const { updatedAt, ...fields } = parsed.data;

  try {
    const [updated] = await db
      .update(agendaItems)
      .set({
        ...(fields.title !== undefined && { title: fields.title }),
        ...(fields.allowDocumentSubmission !== undefined && {
          allowDocumentSubmission: fields.allowDocumentSubmission,
        }),
        ...("documentSubmissionDeadline" in fields && {
          documentSubmissionDeadline: fields.documentSubmissionDeadline
            ? new Date(fields.documentSubmissionDeadline)
            : null,
        }),
        ...(fields.allowAmendments !== undefined && {
          allowAmendments: fields.allowAmendments,
        }),
        ...("amendmentDeadline" in fields && {
          amendmentDeadline: fields.amendmentDeadline
            ? new Date(fields.amendmentDeadline)
            : null,
        }),
      })
      .where(
        and(
          eq(agendaItems.id, itemId),
          eq(agendaItems.assemblyId, assemblyId),
          buildOptimisticLockCondition(agendaItems.updatedAt, updatedAt),
        ),
      )
      .returning();

    if (!updated) {
      throw createError({
        statusCode: 409,
        message:
          "El punto ha sido modificado por otro usuario. Recarga la página.",
      });
    }

    return updated;
  } catch (error) {
    throwMutationError("agenda-items.put", error, event);
  }
});

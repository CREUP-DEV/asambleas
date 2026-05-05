import { defineEventHandler, readBody, createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agendaItems, assemblies } from "../../../../db/schema";
import { requirePermission } from "../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../utils/errors";
import { validateCuid } from "../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";
import { createAgendaItemSchema } from "~~/shared/utils/schemas/agendaItem";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_MANAGE);

  const assemblyId = validateCuid(event.context.params?.id, "Assembly ID");

  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
    columns: { id: true, status: true },
  });

  if (!assembly) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const body = await readBody(event);
  const parsed = createAgendaItemSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Datos de punto inválidos" });
  }

  const {
    parentId,
    title,
    order,
    allowDocumentSubmission,
    documentSubmissionDeadline,
    allowAmendments,
    amendmentDeadline,
  } = parsed.data;

  // Root items cannot be added to definitive assemblies
  if (!parentId && assembly.status === ASSEMBLY_STATUSES.DEFINITIVE) {
    throw createError({
      statusCode: 409,
      message: "No se pueden añadir puntos raíz a una asamblea definitiva",
    });
  }

  // Validate parentId belongs to this assembly
  if (parentId) {
    const parent = await db.query.agendaItems.findFirst({
      where: eq(agendaItems.id, parentId),
      columns: { id: true, assemblyId: true },
    });
    if (!parent || parent.assemblyId !== assemblyId) {
      throw createError({
        statusCode: 400,
        message: "El punto padre no pertenece a esta asamblea",
      });
    }
  }

  try {
    const [item] = await db
      .insert(agendaItems)
      .values({
        assemblyId,
        parentId: parentId ?? null,
        title,
        order,
        allowDocumentSubmission,
        documentSubmissionDeadline: documentSubmissionDeadline
          ? new Date(documentSubmissionDeadline)
          : null,
        allowAmendments,
        amendmentDeadline: amendmentDeadline
          ? new Date(amendmentDeadline)
          : null,
      })
      .returning();

    return item;
  } catch (error) {
    throwMutationError("agenda-items.post", error, event);
  }
});

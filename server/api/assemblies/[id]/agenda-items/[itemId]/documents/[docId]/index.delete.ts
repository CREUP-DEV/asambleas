import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../db";
import { agendaItems, documents } from "../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../../../utils/errors";
import { validateCuid } from "../../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.DOCUMENT_MANAGE);

  const assemblyId = validateCuid(event.context.params?.id, "Assembly ID");
  const itemId = validateCuid(event.context.params?.itemId, "Item ID");
  const docId = validateCuid(event.context.params?.docId, "Document ID");

  const item = await db.query.agendaItems.findFirst({
    where: and(
      eq(agendaItems.id, itemId),
      eq(agendaItems.assemblyId, assemblyId),
    ),
    columns: { id: true },
  });

  if (!item) {
    throw createError({ statusCode: 404, message: "Punto no encontrado" });
  }

  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.agendaItemId, itemId)),
    columns: { id: true },
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  try {
    await db
      .delete(documents)
      .where(and(eq(documents.id, docId), eq(documents.agendaItemId, itemId)));

    return { success: true };
  } catch (error) {
    throwMutationError("documents.delete", error, event);
  }
});

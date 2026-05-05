import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../db";
import { documents } from "../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../../../utils/errors";
import {
  resolveAgendaItemFromParam,
  resolveAssemblyFromParam,
} from "../../../../../../../utils/routeResolvers";
import { validateCuid } from "../../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.DOCUMENT_MANAGE);

  const docId = validateCuid(event.context.params?.docId, "Document ID");
  const assembly = await resolveAssemblyFromParam(event.context.params?.id);
  const item = await resolveAgendaItemFromParam(
    assembly.id,
    event.context.params?.itemId,
  );

  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.agendaItemId, item.id)),
    columns: { id: true },
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  try {
    await db
      .delete(documents)
      .where(and(eq(documents.id, docId), eq(documents.agendaItemId, item.id)));

    return { success: true };
  } catch (error) {
    throwMutationError("documents.delete", error, event);
  }
});

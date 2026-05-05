import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../db";
import { documents } from "../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../../../utils/errors";
import { buildOptimisticLockCondition } from "../../../../../../../utils/optimisticLock";
import {
  resolveAgendaItemFromParam,
  resolveAssemblyFromParam,
} from "../../../../../../../utils/routeResolvers";
import { validateCuid } from "../../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { updateDocumentStatusSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.AMENDMENT_REVIEW);

  const docId = validateCuid(event.context.params?.docId, "Document ID");
  const assembly = await resolveAssemblyFromParam(event.context.params?.id);
  const item = await resolveAgendaItemFromParam(
    assembly.id,
    event.context.params?.itemId,
  );

  const existing = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.agendaItemId, item.id)),
    columns: { id: true, status: true, submittedBy: true, updatedAt: true },
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const body = await readBody(event);
  const parsed = updateDocumentStatusSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Datos inválidos" });
  }

  const { status: newStatus, proponentId, updatedAt } = parsed.data;

  // When accepting a pending document, set proponentId to submittedBy if not provided
  const resolvedProponentId =
    newStatus === "accepted"
      ? (proponentId ?? existing.submittedBy)
      : undefined;

  try {
    const [updated] = await db
      .update(documents)
      .set({
        status: newStatus,
        ...(resolvedProponentId !== undefined && {
          proponentId: resolvedProponentId,
        }),
      })
      .where(
        and(
          eq(documents.id, docId),
          eq(documents.agendaItemId, item.id),
          buildOptimisticLockCondition(documents.updatedAt, updatedAt),
        ),
      )
      .returning();

    if (!updated) {
      throw createError({
        statusCode: 409,
        message:
          "El documento ha sido modificado por otro usuario. Recarga la página.",
      });
    }

    return updated;
  } catch (error) {
    throwMutationError("documents.status.put", error, event);
  }
});

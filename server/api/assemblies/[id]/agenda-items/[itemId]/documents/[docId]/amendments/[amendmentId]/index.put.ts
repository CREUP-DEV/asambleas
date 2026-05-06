import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../../../db";
import { amendments, documents } from "../../../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../../../utils/auth/rbac";
import { getAuthUserWithRole } from "../../../../../../../../../utils/auth/requireAuth";
import { assertOptimisticLock } from "../../../../../../../../../utils/optimisticLock";
import { throwMutationError } from "../../../../../../../../../utils/errors";
import { sanitizeRichTextHtml } from "../../../../../../../../../utils/richText";
import { validateCuid } from "../../../../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { AMENDMENT_STATUSES } from "~~/shared/constants/statuses";
import { updateAmendmentSchema } from "~~/shared/utils/schemas/amendment";
import { computePatch, hashContent } from "~~/shared/utils/diff";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.AMENDMENT_MANAGE);
  const user = await getAuthUserWithRole(event);

  const docId = validateCuid(event.context.params?.docId, "Document ID");
  const amendmentId = validateCuid(
    event.context.params?.amendmentId,
    "Amendment ID",
  );

  const amendment = await db.query.amendments.findFirst({
    where: and(
      eq(amendments.id, amendmentId),
      eq(amendments.documentId, docId),
    ),
  });

  if (!amendment) {
    throw createError({ statusCode: 404, message: "Enmienda no encontrada" });
  }

  if (amendment.status !== AMENDMENT_STATUSES.DRAFT) {
    throw createError({
      statusCode: 400,
      message: "Solo se pueden editar enmiendas en borrador",
    });
  }

  if (amendment.submittedBy !== user?.id) {
    throw createError({
      statusCode: 403,
      message: "Solo el autor puede editar esta enmienda",
    });
  }

  const body = await readBody(event);
  const parsed = updateAmendmentSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de la enmienda inválidos",
    });
  }

  assertOptimisticLock(
    parsed.data.updatedAt,
    amendment.updatedAt,
    "La enmienda ha sido modificada por otro usuario",
  );

  const updateData: Record<string, unknown> = {};

  if (parsed.data.justification !== undefined) {
    updateData.justification = parsed.data.justification;
  }

  if (parsed.data.content !== undefined) {
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, docId),
      columns: { content: true },
    });

    const baseContent = doc?.content ?? "";
    const sanitizedContent = sanitizeRichTextHtml(parsed.data.content);
    updateData.contentPatch = computePatch(baseContent, sanitizedContent);
    updateData.baseContentVersion = await hashContent(baseContent);
  }

  if (Object.keys(updateData).length === 0) {
    return amendment;
  }

  try {
    const [updated] = await db
      .update(amendments)
      .set(updateData)
      .where(eq(amendments.id, amendmentId))
      .returning();

    return updated;
  } catch (error) {
    throwMutationError("amendments.put", error, event);
  }
});

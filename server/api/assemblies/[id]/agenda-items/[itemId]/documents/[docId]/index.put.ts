import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../db";
import { documents } from "../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../../../utils/errors";
import { buildOptimisticLockCondition } from "../../../../../../../utils/optimisticLock";
import { sanitizeRichTextHtml } from "../../../../../../../utils/richText";
import {
  resolveAgendaItemFromParam,
  resolveAssemblyFromParam,
} from "../../../../../../../utils/routeResolvers";
import { validateCuid } from "../../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  updatePlatformDocumentSchema,
  updatePdfDocumentSchema,
} from "~~/shared/utils/schemas/document";
import { hashContent } from "~~/shared/utils/diff";

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
    columns: { id: true, type: true, updatedAt: true },
  });

  if (!existing) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const body = await readBody(event);

  try {
    if (existing.type === "platform") {
      const parsed = updatePlatformDocumentSchema.safeParse(body);
      if (!parsed.success) {
        throw createError({ statusCode: 400, message: "Datos inválidos" });
      }

      const { updatedAt, content, title } = parsed.data;
      const sanitizedContent =
        content !== undefined ? sanitizeRichTextHtml(content) : undefined;
      const newContentVersion = sanitizedContent
        ? await hashContent(sanitizedContent)
        : undefined;

      const [updated] = await db
        .update(documents)
        .set({
          ...(title !== undefined && { title }),
          ...(sanitizedContent !== undefined && {
            content: sanitizedContent,
            contentVersion: newContentVersion,
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
    } else {
      const parsed = updatePdfDocumentSchema.safeParse(body);
      if (!parsed.success) {
        throw createError({ statusCode: 400, message: "Datos inválidos" });
      }

      const { updatedAt, fileUrl, title } = parsed.data;

      const [updated] = await db
        .update(documents)
        .set({
          ...(title !== undefined && { title }),
          ...(fileUrl !== undefined && { fileUrl }),
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
    }
  } catch (error) {
    throwMutationError("documents.put", error, event);
  }
});

import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../../db";
import { amendments, documents } from "../../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../../utils/auth/rbac";
import { getAuthUserWithRole } from "../../../../../../../../utils/auth/requireAuth";
import { throwMutationError } from "../../../../../../../../utils/errors";
import {
  resolveAgendaItemFromParam,
  resolveAssemblyFromParam,
} from "../../../../../../../../utils/routeResolvers";
import { sanitizeRichTextHtml } from "../../../../../../../../utils/richText";
import { validateCuid } from "../../../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { DOCUMENT_STATUSES } from "~~/shared/constants/statuses";
import { createAmendmentSchema } from "~~/shared/utils/schemas/amendment";
import { computePatch, hashContent } from "~~/shared/utils/diff";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.AMENDMENT_CREATE);
  const user = await getAuthUserWithRole(event);

  const docId = validateCuid(event.context.params?.docId, "Document ID");

  const assembly = await resolveAssemblyFromParam(event.context.params?.id);
  const item = await resolveAgendaItemFromParam(
    assembly.id,
    event.context.params?.itemId,
  );

  if (!item.allowAmendments) {
    throw createError({
      statusCode: 403,
      message: "Las enmiendas no están habilitadas para este punto",
    });
  }

  if (item.amendmentDeadline && new Date() > item.amendmentDeadline) {
    throw createError({
      statusCode: 409,
      message: "El plazo para presentar enmiendas ha vencido",
    });
  }

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.agendaItemId, item.id)),
  });

  if (!doc) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  if (doc.status !== DOCUMENT_STATUSES.ACCEPTED) {
    throw createError({
      statusCode: 400,
      message: "Solo se pueden enmendar documentos aceptados",
    });
  }

  if (doc.type !== "platform") {
    throw createError({
      statusCode: 400,
      message: "Solo se pueden enmendar documentos de plataforma",
    });
  }

  const body = await readBody(event);
  const parsed = createAmendmentSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de la enmienda inválidos",
    });
  }

  const { content, justification } = parsed.data;
  const modifiedContent = sanitizeRichTextHtml(content);
  const baseContent = doc.content ?? "";
  const baseContentVersion = await hashContent(baseContent);
  const contentPatch = computePatch(baseContent, modifiedContent);

  try {
    const [amendment] = await db
      .insert(amendments)
      .values({
        documentId: docId,
        submittedBy: user!.id,
        contentPatch,
        baseContentVersion,
        justification,
        type: "regular",
        status: "draft",
      })
      .returning();

    return amendment;
  } catch (error) {
    throwMutationError("amendments.post", error, event);
  }
});

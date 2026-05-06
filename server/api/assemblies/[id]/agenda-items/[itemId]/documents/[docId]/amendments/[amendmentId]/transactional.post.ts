import { defineEventHandler, readBody, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../../../db";
import { amendments, documents } from "../../../../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../../../../utils/auth/rbac";
import { throwMutationError } from "../../../../../../../../../utils/errors";
import { sanitizeRichTextHtml } from "../../../../../../../../../utils/richText";
import { validateCuid } from "../../../../../../../../../utils/validation";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { AMENDMENT_STATUSES } from "~~/shared/constants/statuses";
import { createTransactionalSchema } from "~~/shared/utils/schemas/amendment";
import { computePatch, hashContent } from "~~/shared/utils/diff";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const docId = validateCuid(event.context.params?.docId, "Document ID");
  const amendmentId = validateCuid(
    event.context.params?.amendmentId,
    "Amendment ID",
  );

  const parentAmendment = await db.query.amendments.findFirst({
    where: and(
      eq(amendments.id, amendmentId),
      eq(amendments.documentId, docId),
    ),
  });

  if (!parentAmendment) {
    throw createError({ statusCode: 404, message: "Enmienda no encontrada" });
  }

  if (parentAmendment.status !== AMENDMENT_STATUSES.ACCEPTED_SECRETARIA) {
    throw createError({
      statusCode: 400,
      message:
        "Solo se pueden crear enmiendas transaccionales sobre enmiendas validadas por Secretaría",
    });
  }

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, docId),
    columns: { id: true, content: true, proponentId: true },
  });

  if (!doc) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const isPrivileged =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;
  const isProponent = doc.proponentId === user?.id;
  const isAmendmentAuthor = parentAmendment.submittedBy === user?.id;

  if (!isPrivileged && !isProponent && !isAmendmentAuthor) {
    throw createError({
      statusCode: 403,
      message:
        "Solo el proponente del documento o el autor de la enmienda pueden crear transaccionales",
    });
  }

  const body = await readBody(event);
  const parsed = createTransactionalSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de la enmienda transaccional inválidos",
    });
  }

  const { content, justification } = parsed.data;
  const modifiedContent = sanitizeRichTextHtml(content);
  const baseContent = doc.content ?? "";
  const baseContentVersion = await hashContent(baseContent);
  const contentPatch = computePatch(baseContent, modifiedContent);

  try {
    const [transactional] = await db
      .insert(amendments)
      .values({
        documentId: docId,
        submittedBy: user!.id,
        contentPatch,
        baseContentVersion,
        justification,
        type: "regular",
        status: "draft",
        parentAmendmentId: amendmentId,
      })
      .returning();

    return transactional;
  } catch (error) {
    throwMutationError("amendments.transactional", error, event);
  }
});

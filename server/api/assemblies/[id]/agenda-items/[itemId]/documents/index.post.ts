import { defineEventHandler, readBody, createError, getQuery } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import {
  agendaItems,
  assemblies,
  documents,
} from "../../../../../../db/schema";
import { requirePermission, isAdmin } from "../../../../../../utils/auth/rbac";
import { getAuthUserWithRole } from "../../../../../../utils/auth/requireAuth";
import { throwMutationError } from "../../../../../../utils/errors";
import { sanitizeRichTextHtml } from "../../../../../../utils/richText";
import { validateCuid } from "../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { DOCUMENT_STATUSES } from "~~/shared/constants/statuses";
import {
  createPlatformDocumentSchema,
  createPdfDocumentSchema,
} from "~~/shared/utils/schemas/document";
import { hashContent } from "~~/shared/utils/diff";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.DOCUMENT_CREATE);
  const user = await getAuthUserWithRole(event);

  const assemblyId = validateCuid(event.context.params?.id, "Assembly ID");
  const itemId = validateCuid(event.context.params?.itemId, "Item ID");

  const queryParams = getQuery(event);
  const docType = queryParams.type === "pdf" ? "pdf" : "platform";

  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
    columns: { id: true, status: true },
  });

  if (!assembly) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const item = await db.query.agendaItems.findFirst({
    where: and(
      eq(agendaItems.id, itemId),
      eq(agendaItems.assemblyId, assemblyId),
    ),
  });

  if (!item) {
    throw createError({ statusCode: 404, message: "Punto no encontrado" });
  }

  const isOfficial =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  // Asociados can only submit if allowed and within deadline
  if (!isOfficial) {
    if (!item.allowDocumentSubmission) {
      throw createError({
        statusCode: 403,
        message:
          "La presentación de documentos no está habilitada para este punto",
      });
    }
    if (
      item.documentSubmissionDeadline &&
      new Date() > item.documentSubmissionDeadline
    ) {
      throw createError({
        statusCode: 409,
        message: "El plazo para presentar documentos ha vencido",
      });
    }
    // PDF not allowed for non-official submissions
    if (docType === "pdf") {
      throw createError({
        statusCode: 403,
        message: "Los documentos PDF solo pueden ser creados por Secretaría",
      });
    }
  }

  const body = await readBody(event);

  try {
    if (docType === "platform") {
      const parsed = createPlatformDocumentSchema.safeParse(body);
      if (!parsed.success) {
        throw createError({
          statusCode: 400,
          message: "Datos del documento inválidos",
        });
      }

      const { title } = parsed.data;
      const content = sanitizeRichTextHtml(parsed.data.content);
      const contentVersion = await hashContent(content);
      const initialStatus = isOfficial
        ? DOCUMENT_STATUSES.ACCEPTED
        : DOCUMENT_STATUSES.PENDING_REVIEW;

      const [doc] = await db
        .insert(documents)
        .values({
          agendaItemId: itemId,
          type: "platform",
          title,
          content,
          contentVersion,
          submittedBy: user?.id ?? null,
          proponentId: isOfficial ? (user?.id ?? null) : null,
          status: initialStatus,
        })
        .returning();

      return doc;
    } else {
      const parsed = createPdfDocumentSchema.safeParse(body);
      if (!parsed.success) {
        throw createError({
          statusCode: 400,
          message: "Datos del documento inválidos",
        });
      }

      const { title, fileUrl } = parsed.data;

      const [doc] = await db
        .insert(documents)
        .values({
          agendaItemId: itemId,
          type: "pdf",
          title,
          fileUrl,
          contentVersion: "",
          submittedBy: user?.id ?? null,
          proponentId: user?.id ?? null,
          status: DOCUMENT_STATUSES.ACCEPTED,
        })
        .returning();

      return doc;
    }
  } catch (error) {
    throwMutationError("documents.post", error, event);
  }
});

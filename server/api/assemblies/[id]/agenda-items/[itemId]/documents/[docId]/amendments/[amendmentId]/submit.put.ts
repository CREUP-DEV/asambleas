import { defineEventHandler, createError } from "h3";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../../../../../../db";
import { amendments } from "../../../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../../../utils/auth/rbac";
import { getAuthUserWithRole } from "../../../../../../../../../utils/auth/requireAuth";
import { throwMutationError } from "../../../../../../../../../utils/errors";
import { validateCuid } from "../../../../../../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { AMENDMENT_STATUSES } from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.AMENDMENT_CREATE);
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
      message: "Solo se pueden enviar enmiendas en borrador",
    });
  }

  if (amendment.submittedBy !== user?.id) {
    throw createError({
      statusCode: 403,
      message: "Solo el autor puede enviar esta enmienda",
    });
  }

  try {
    const [updated] = await db
      .update(amendments)
      .set({
        status: AMENDMENT_STATUSES.PENDING_REVIEW,
        submittedAt: sql`now()`,
      })
      .where(eq(amendments.id, amendmentId))
      .returning();

    return updated;
  } catch (error) {
    throwMutationError("amendments.submit", error, event);
  }
});

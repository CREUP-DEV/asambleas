import { defineEventHandler, readBody, createError } from "h3";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../../../../../../db";
import { amendments, documents } from "../../../../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../../../../utils/auth/rbac";
import { assertOptimisticLock } from "../../../../../../../../../utils/optimisticLock";
import { throwMutationError } from "../../../../../../../../../utils/errors";
import { validateCuid } from "../../../../../../../../../utils/validation";
import {
  incorporateAmendment,
  shouldIncorporate,
  getIncorporationType,
} from "../../../../../../../../../utils/amendmentWorkflow";
import { AMENDMENT_STATUSES } from "~~/shared/constants/statuses";
import { proponentDecisionSchema } from "~~/shared/utils/schemas/amendment";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
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

  if (amendment.status !== AMENDMENT_STATUSES.ACCEPTED_SECRETARIA) {
    throw createError({
      statusCode: 400,
      message: "Solo se pueden decidir enmiendas validadas por Secretaría",
    });
  }

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, docId),
    columns: { proponentId: true },
  });

  if (!doc) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  if (!doc.proponentId) {
    throw createError({
      statusCode: 409,
      message: "El documento necesita un proponente antes de decidir enmiendas",
    });
  }

  const canDecide = isAdmin(user?.role?.name) || doc.proponentId === user?.id;

  if (!canDecide) {
    throw createError({
      statusCode: 403,
      message:
        "Solo el proponente del documento puede decidir sobre esta enmienda",
    });
  }

  const body = await readBody(event);
  const parsed = proponentDecisionSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de decisión inválidos",
    });
  }

  assertOptimisticLock(
    parsed.data.updatedAt,
    amendment.updatedAt,
    "La enmienda ha sido modificada por otro usuario",
  );

  const newStatus =
    parsed.data.action === "accept"
      ? AMENDMENT_STATUSES.ACCEPTED_PROPONENT
      : AMENDMENT_STATUSES.REJECTED_PROPONENT;

  try {
    if (shouldIncorporate(newStatus)) {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(amendments)
          .set({
            status: newStatus,
            proponentDecidedAt: sql`now()`,
          })
          .where(eq(amendments.id, amendmentId))
          .returning();

        await incorporateAmendment(
          tx,
          amendmentId,
          getIncorporationType(newStatus)!,
        );

        return updated;
      });

      return result;
    }

    const [updated] = await db
      .update(amendments)
      .set({
        status: newStatus,
        proponentDecidedAt: sql`now()`,
      })
      .where(eq(amendments.id, amendmentId))
      .returning();

    return updated;
  } catch (error) {
    throwMutationError("amendments.proponent-decision", error, event);
  }
});

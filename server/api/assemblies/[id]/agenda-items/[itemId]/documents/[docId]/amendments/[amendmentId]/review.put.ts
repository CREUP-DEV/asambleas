import { defineEventHandler, readBody, createError } from "h3";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../../../../../../../db";
import { amendments } from "../../../../../../../../../db/schema";
import { requirePermission } from "../../../../../../../../../utils/auth/rbac";
import { assertOptimisticLock } from "../../../../../../../../../utils/optimisticLock";
import { throwMutationError } from "../../../../../../../../../utils/errors";
import { validateCuid } from "../../../../../../../../../utils/validation";
import {
  incorporateAmendment,
  shouldIncorporate,
  getIncorporationType,
} from "../../../../../../../../../utils/amendmentWorkflow";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  AMENDMENT_STATUSES,
  type AmendmentStatus,
} from "~~/shared/constants/statuses";
import { reviewAmendmentSchema } from "~~/shared/utils/schemas/amendment";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.AMENDMENT_REVIEW);

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

  if (amendment.status !== AMENDMENT_STATUSES.PENDING_REVIEW) {
    throw createError({
      statusCode: 400,
      message: "Solo se pueden revisar enmiendas pendientes de revisión",
    });
  }

  const body = await readBody(event);
  const parsed = reviewAmendmentSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos de revisión inválidos",
    });
  }

  assertOptimisticLock(
    parsed.data.updatedAt,
    amendment.updatedAt,
    "La enmienda ha sido modificada por otro usuario",
  );

  const { action } = parsed.data;
  let newStatus: AmendmentStatus;
  let newType: "regular" | "formal" = amendment.type;

  switch (action) {
    case "reject":
      newStatus = AMENDMENT_STATUSES.REJECTED_SECRETARIA;
      break;
    case "formal":
      newStatus = AMENDMENT_STATUSES.FORMAL;
      newType = "formal";
      break;
    case "accept":
      newStatus = AMENDMENT_STATUSES.ACCEPTED_SECRETARIA;
      break;
  }

  try {
    if (shouldIncorporate(newStatus)) {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(amendments)
          .set({
            status: newStatus,
            type: newType,
            secretariaReviewedAt: sql`now()`,
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
        type: newType,
        secretariaReviewedAt: sql`now()`,
      })
      .where(eq(amendments.id, amendmentId))
      .returning();

    return updated;
  } catch (error) {
    throwMutationError("amendments.review", error, event);
  }
});

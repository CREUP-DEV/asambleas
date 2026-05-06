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
import { AMENDMENT_STATUSES } from "~~/shared/constants/statuses";
import { voteResultSchema } from "~~/shared/utils/schemas/amendment";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT);

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

  if (amendment.status !== AMENDMENT_STATUSES.REJECTED_PROPONENT) {
    throw createError({
      statusCode: 400,
      message:
        "Solo se pueden registrar votos en enmiendas rechazadas por el proponente",
    });
  }

  const body = await readBody(event);
  const parsed = voteResultSchema.safeParse(body);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Datos del resultado inválidos",
    });
  }

  assertOptimisticLock(
    parsed.data.updatedAt,
    amendment.updatedAt,
    "La enmienda ha sido modificada por otro usuario",
  );

  const newStatus =
    parsed.data.result === "approved"
      ? AMENDMENT_STATUSES.APPROVED_VOTE
      : AMENDMENT_STATUSES.REJECTED_VOTE;

  try {
    if (shouldIncorporate(newStatus)) {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(amendments)
          .set({
            status: newStatus,
            voteRecordedAt: sql`now()`,
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
        voteRecordedAt: sql`now()`,
      })
      .where(eq(amendments.id, amendmentId))
      .returning();

    return updated;
  } catch (error) {
    throwMutationError("amendments.vote-result", error, event);
  }
});

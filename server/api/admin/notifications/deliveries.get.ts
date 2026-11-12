import { desc, eq } from "drizzle-orm";
import { createError, defineEventHandler, getQuery } from "h3";
import { db } from "../../../db";
import { emailDeliveries, users } from "../../../db/schema";
import type {
  EmailDeliveryStatus,
  EmailSkipReason,
  NotificationFrequency,
} from "~~/shared/constants/notifications";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { EmailDeliveryDto } from "~~/shared/types/api";
import { emailDeliveriesQuerySchema } from "~~/shared/utils/schemas/notifications";
import { requireAnyPermission } from "../../../utils/auth/rbac";
import { canManageDocuments, requireActor } from "../../../utils/domain/actor";

/**
 * The latest emails, newest first (notification:manage): the kind, who it
 * went to (the account's name, never its address), when and how it went.
 * The subject names a document, so only whoever reads every document
 * (document:manage) reads it.
 */
export default defineEventHandler(
  async (event): Promise<EmailDeliveryDto[]> => {
    await requireAnyPermission(event, [PERMISSION_KEYS.NOTIFICATION_MANAGE]);
    const actor = await requireActor(event);
    const query = emailDeliveriesQuerySchema.safeParse(getQuery(event));
    if (!query.success) {
      throw createError({ statusCode: 400, message: "Consulta no válida" });
    }
    const readsSubjects = canManageDocuments(actor);
    const rows = await db
      .select({
        delivery: emailDeliveries,
        recipientName: users.name,
      })
      .from(emailDeliveries)
      .leftJoin(users, eq(users.id, emailDeliveries.userId))
      .orderBy(desc(emailDeliveries.createdAt), desc(emailDeliveries.id))
      .limit(query.data.limit);
    return rows.map(({ delivery, recipientName }) => ({
      id: delivery.id,
      kind: delivery.kind,
      status: delivery.status as EmailDeliveryStatus,
      frequency: delivery.frequency as NotificationFrequency,
      reason: (delivery.reason as EmailSkipReason | null) ?? null,
      subject: readsSubjects ? delivery.subject : null,
      recipient:
        recipientName !== null
          ? { id: delivery.userId, name: recipientName }
          : null,
      attempts: delivery.attempts,
      error: delivery.lastError,
      createdAt: delivery.createdAt.toISOString(),
      sentAt: delivery.sentAt?.toISOString() ?? null,
    }));
  },
);

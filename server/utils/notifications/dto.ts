import { gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { emailDeliveries, roles } from "../../db/schema";
import {
  EMAIL_DELIVERY_STATUSES,
  type EmailDeliveryStatus,
} from "~~/shared/constants/notifications";
import type { NotificationSettingsDto } from "~~/shared/types/api";
import { readSmtpConfig } from "./mailer";
import { loadNotificationSettings } from "./settings";

/**
 * What /admin/notificaciones reads: the settings, the roles there are,
 * whether SMTP is configured and how the last day went.
 */
export async function loadNotificationSettingsDto(): Promise<NotificationSettingsDto> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [stored, roleRows, counts] = await Promise.all([
    loadNotificationSettings(),
    db.select({ name: roles.name }).from(roles).orderBy(roles.name),
    db
      .select({
        status: emailDeliveries.status,
        count: sql<number>`count(*)::int`,
      })
      .from(emailDeliveries)
      .where(gte(emailDeliveries.createdAt, since))
      .groupBy(emailDeliveries.status),
  ]);
  const lastDay = Object.fromEntries(
    EMAIL_DELIVERY_STATUSES.map((status) => [status, 0]),
  ) as Record<EmailDeliveryStatus, number>;
  for (const row of counts) {
    if (row.status in lastDay) {
      lastDay[row.status as EmailDeliveryStatus] = row.count;
    }
  }
  const smtp = readSmtpConfig();
  return {
    settings: stored.settings,
    updatedAt: stored.updatedAt?.toISOString() ?? null,
    roles: roleRows.map((row) => row.name),
    smtp: { configured: smtp !== null, from: smtp?.fromEmail ?? null },
    lastDay,
  };
}

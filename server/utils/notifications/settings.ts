import { eq } from "drizzle-orm";
import { createError, type H3Event } from "h3";
import { db } from "../../db";
import { notificationSettings } from "../../db/schema";
import type { Executor } from "../domain/events";
import { recordAudit } from "../domain/audit";
import type { Actor } from "../domain/actor";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type { NotificationSettings } from "~~/shared/constants/notifications";
import {
  normalizeNotificationSettings,
  readNotificationSettings,
} from "~~/shared/utils/schemas/notifications";
import {
  assertOptimisticLock,
  buildOptimisticLockCondition,
} from "../optimisticLock";

/** The one row of notification_settings. */
export const NOTIFICATION_SETTINGS_ID = "email";

export interface StoredNotificationSettings {
  settings: NotificationSettings;
  updatedAt: Date | null;
}

/** The settings in force: the stored row over the defaults. */
export async function loadNotificationSettings(
  executor: Executor = db,
): Promise<StoredNotificationSettings> {
  const [row] = await executor
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.id, NOTIFICATION_SETTINGS_ID));
  return {
    settings: readNotificationSettings(row?.settings),
    updatedAt: row?.updatedAt ?? null,
  };
}

const CONFLICT =
  "Otra persona ha cambiado los avisos por correo. Recarga la página.";

/**
 * Replaces the settings (PUT /api/admin/notifications). The client sends
 * the `updatedAt` it read, null while nothing was stored; any mismatch is a
 * 409. Writes `notifications.update` with the settings before and after; an
 * unchanged save writes nothing. Deliveries already queued keep the
 * frequency they were queued with, but one that has not gone yet is
 * skipped if its kind is turned off.
 */
export async function updateNotificationSettings(input: {
  event: H3Event;
  actor: Actor;
  settings: NotificationSettings;
  updatedAt: string | null;
}): Promise<StoredNotificationSettings> {
  const next = normalizeNotificationSettings(input.settings);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.id, NOTIFICATION_SETTINGS_ID))
      .for("update");

    const before = readNotificationSettings(current?.settings);
    let saved: typeof notificationSettings.$inferSelect | undefined;
    if (!current) {
      if (input.updatedAt !== null) {
        throw createError({ statusCode: 409, message: CONFLICT });
      }
      [saved] = await tx
        .insert(notificationSettings)
        .values({
          id: NOTIFICATION_SETTINGS_ID,
          settings: next as unknown as Record<string, unknown>,
          updatedByUserId: input.actor.user.id,
        })
        .onConflictDoNothing({ target: notificationSettings.id })
        .returning();
    } else {
      if (input.updatedAt === null) {
        throw createError({ statusCode: 409, message: CONFLICT });
      }
      assertOptimisticLock(input.updatedAt, current.updatedAt, CONFLICT);
      [saved] = await tx
        .update(notificationSettings)
        .set({
          settings: next as unknown as Record<string, unknown>,
          updatedByUserId: input.actor.user.id,
        })
        .where(
          buildOptimisticLockCondition(
            notificationSettings.updatedAt,
            input.updatedAt,
          ),
        )
        .returning();
    }
    if (!saved) throw createError({ statusCode: 409, message: CONFLICT });

    await recordAudit(tx, {
      event: input.event,
      actor: input.actor,
      action: AUDIT_ACTIONS.NOTIFICATIONS_UPDATE,
      targetType: "notification_settings",
      targetId: NOTIFICATION_SETTINGS_ID,
      before: { settings: before },
      after: { settings: next },
      // Storing the first row is a change even when it keeps the defaults.
      recordUnchanged: !current,
    });

    return { settings: next, updatedAt: saved.updatedAt };
  });
}

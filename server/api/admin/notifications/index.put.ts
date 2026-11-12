import { createError, defineEventHandler, readBody } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { NotificationSettingsDto } from "~~/shared/types/api";
import { notificationSettingsBodySchema } from "~~/shared/utils/schemas/notifications";
import { requireAnyPermission } from "../../../utils/auth/rbac";
import { requireActor } from "../../../utils/domain/actor";
import { updateNotificationSettings } from "../../../utils/notifications/settings";
import { loadNotificationSettingsDto } from "../../../utils/notifications/dto";

/**
 * Replaces the email notification settings (notification:manage), with
 * optimistic locking on `updatedAt`. Audit `notifications.update`.
 */
export default defineEventHandler(
  async (event): Promise<NotificationSettingsDto> => {
    await requireAnyPermission(event, [PERMISSION_KEYS.NOTIFICATION_MANAGE]);
    const actor = await requireActor(event);
    const body = notificationSettingsBodySchema.safeParse(
      await readBody(event),
    );
    if (!body.success) {
      throw createError({
        statusCode: 400,
        message: "Ajustes de avisos no válidos",
      });
    }
    await updateNotificationSettings({
      event,
      actor,
      settings: body.data.settings,
      updatedAt: body.data.updatedAt,
    });
    return loadNotificationSettingsDto();
  },
);

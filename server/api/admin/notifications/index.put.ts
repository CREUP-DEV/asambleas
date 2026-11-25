import { defineEventHandler } from "h3";
import { readBodyWith } from "../../../utils/core/http";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { NotificationSettingsDto } from "~~/shared/types/api";
import { notificationSettingsBodySchema } from "~~/shared/utils/schemas/notifications";
import { requireAnyPermission } from "../../../utils/auth/rbac";
import { updateNotificationSettings } from "../../../utils/notifications/settings";
import { loadNotificationSettingsDto } from "../../../utils/notifications/dto";

/**
 * Replaces the email notification settings (notification:manage), with
 * optimistic locking on `updatedAt`. Audit `notifications.update`.
 */
export default defineEventHandler(
  async (event): Promise<NotificationSettingsDto> => {
    const { actor } = await requireAnyPermission(event, [
      PERMISSION_KEYS.NOTIFICATION_MANAGE,
    ]);
    const body = await readBodyWith(event, notificationSettingsBodySchema, {
      message: "Ajustes de avisos no válidos",
    });
    await updateNotificationSettings({
      event,
      actor,
      settings: body.settings,
      updatedAt: body.updatedAt,
    });
    return loadNotificationSettingsDto();
  },
);

import { defineEventHandler } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { NotificationSettingsDto } from "~~/shared/types/api";
import { requireAnyPermission } from "../../../utils/auth/rbac";
import { loadNotificationSettingsDto } from "../../../utils/notifications/dto";

/**
 * The email notification settings (notification:manage): what is sent, to
 * which roles and how often, the roles there are, whether SMTP is
 * configured and how the last day went.
 */
export default defineEventHandler(
  async (event): Promise<NotificationSettingsDto> => {
    await requireAnyPermission(event, [PERMISSION_KEYS.NOTIFICATION_MANAGE]);
    return loadNotificationSettingsDto();
  },
);

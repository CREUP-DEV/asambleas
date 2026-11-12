import { defineEventHandler } from "h3";
import { db } from "../../../db";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { EmailTestResultDto } from "~~/shared/types/api";
import { requireAnyPermission } from "../../../utils/auth/rbac";
import { requireActor } from "../../../utils/domain/actor";
import { recordAudit } from "../../../utils/domain/audit";
import { NOTIFICATION_SETTINGS_ID } from "../../../utils/notifications/settings";
import { sendTestEmail } from "../../../utils/notifications/sender";

/**
 * Sends a test email to the caller's own address (notification:manage),
 * now, and lists it in the log. Audit `notifications.test`.
 */
export default defineEventHandler(
  async (event): Promise<EmailTestResultDto> => {
    await requireAnyPermission(event, [PERMISSION_KEYS.NOTIFICATION_MANAGE]);
    const actor = await requireActor(event);
    const result = await sendTestEmail(actor);
    await recordAudit(db, {
      event,
      actor,
      action: AUDIT_ACTIONS.NOTIFICATIONS_TEST,
      targetType: "notification_settings",
      targetId: NOTIFICATION_SETTINGS_ID,
      after: { status: result.status, reason: result.reason },
    });
    return result;
  },
);

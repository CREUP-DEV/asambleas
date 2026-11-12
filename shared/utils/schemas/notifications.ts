import { z } from "zod/v4";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_FREQUENCIES,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationKindSettings,
  type NotificationSettings,
} from "../../constants/notifications";

/**
 * The email notification settings (docs/api.md, "Email notifications"):
 * what PUT /api/admin/notifications accepts. The stored jsonb is read
 * leniently (`readNotificationSettings`): a kind or a field it lacks takes
 * the default, and an unknown one is dropped, so a release that adds a kind
 * reads the row the previous one wrote and the other way round.
 */

/** A role name, as stored in roles.name. */
const roleName = z.string().trim().min(1).max(80);

export const notificationKindSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  roles: z.array(roleName).max(40),
  frequency: z.enum(NOTIFICATION_FREQUENCIES),
});

export const notificationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  kinds: z.strictObject(
    Object.fromEntries(
      NOTIFICATION_KINDS.map((kind) => [kind, notificationKindSettingsSchema]),
    ) as Record<NotificationKind, typeof notificationKindSettingsSchema>,
  ),
});

export const notificationSettingsBodySchema = z.strictObject({
  settings: notificationSettingsSchema,
  /** The `updatedAt` the client read; null while nothing was stored. */
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});

/** Sorted, without repeats: equal settings compare equal in the audit. */
export function normalizeNotificationSettings(
  settings: NotificationSettings,
): NotificationSettings {
  const kinds = {} as Record<NotificationKind, NotificationKindSettings>;
  for (const kind of NOTIFICATION_KINDS) {
    const value = settings.kinds[kind];
    kinds[kind] = {
      enabled: value.enabled,
      roles: [...new Set(value.roles)].sort((a, b) => a.localeCompare(b)),
      frequency: value.frequency,
    };
  }
  return { enabled: settings.enabled, kinds };
}

/** A stored row read over the defaults (see the module comment). */
export function readNotificationSettings(
  stored: unknown,
): NotificationSettings {
  const record =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  const storedKinds =
    record.kinds && typeof record.kinds === "object"
      ? (record.kinds as Record<string, unknown>)
      : {};
  const kinds = {} as Record<NotificationKind, NotificationKindSettings>;
  for (const kind of NOTIFICATION_KINDS) {
    const fallback = DEFAULT_NOTIFICATION_SETTINGS.kinds[kind];
    const parsed = notificationKindSettingsSchema
      .partial()
      .safeParse(storedKinds[kind] ?? {});
    const value = parsed.success ? parsed.data : {};
    kinds[kind] = {
      enabled: value.enabled ?? fallback.enabled,
      roles: value.roles ?? fallback.roles,
      frequency: value.frequency ?? fallback.frequency,
    };
  }
  return normalizeNotificationSettings({
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_NOTIFICATION_SETTINGS.enabled,
    kinds,
  });
}

export const emailDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

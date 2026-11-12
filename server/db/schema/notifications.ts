import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { assemblies } from "./assembly";
import { cuid } from "./common";
import { events } from "./session";

/**
 * Email notifications (docs/design.md, "Email notifications";
 * server/utils/notifications/*).
 */

/**
 * The settings of /admin/notificaciones: one row (`id` "email"), read over
 * DEFAULT_NOTIFICATION_SETTINGS by readNotificationSettings, so a kind
 * added later needs no migration. Absent until someone saves the page.
 */
export const notificationSettings = pgTable("notification_settings", {
  id: text("id").primaryKey(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`now()`),
});

/**
 * The outbox: recordEvent adds a row, in the transaction of the change,
 * for every event that may notify (NOTIFYING_EVENT_TYPES). The sender reads
 * them once committed, works out who gets what (email_deliveries) and marks
 * them processed, so a rolled-back change never sends an email and a
 * restart never loses one.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "date",
    }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    index("notification_outbox_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.processedAt} is null`),
  ],
);

/**
 * One email to one account: what the log of /admin/notificaciones lists.
 * Its content is composed when it goes, as that account sees things then,
 * and never stored; only the subject is kept once sent. Never the address.
 * `dedupeKey` is unique per account, so an event processed twice, or a
 * transactional accepted again, sends one email.
 */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    /** A NotificationKind, or "test". */
    kind: text("kind").notNull(),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    assemblyId: text("assembly_id").references(() => assemblies.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    /** "immediate" or "daily" (NotificationFrequency), fixed when queued. */
    frequency: text("frequency").notNull().default("immediate"),
    /** EmailDeliveryStatus. */
    status: text("status").notNull().default("pending"),
    /** EmailSkipReason, for `skipped`. */
    reason: text("reason"),
    subject: text("subject"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Not before this time (the backoff after a failed attempt). */
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    unique("email_deliveries_user_dedupe_unique").on(
      table.userId,
      table.dedupeKey,
    ),
    index("email_deliveries_pending_idx")
      .on(table.frequency, table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index("email_deliveries_created_idx").on(table.createdAt),
  ],
);

import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cuid } from "./common";
import { users } from "./auth";
import type { ImpersonationEndReason } from "../../../shared/constants/activity";

/**
 * An Admin acting as another account (server/utils/auth/impersonation.ts).
 * The row is a server-side pointer keyed by the Admin's own better-auth
 * session: no session or credential is ever issued for the target. It
 * applies while `ended_at` is null and `expires_at` is in the future; it is
 * closed by a stop, lazily on the first request after expiry, when the
 * Admin signs out, or when either account's role makes it invalid.
 */
export const impersonations = pgTable(
  "impersonations",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    /** The real Admin. */
    adminUserId: text("admin_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The account acted as. */
    targetUserId: text("target_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * The Admin's better-auth `sessions.id`. Deliberately no foreign key:
     * the record must survive sign-out, which deletes the session row.
     */
    sessionId: text("session_id").notNull(),
    /** Why the Admin needed it (1..200 characters), written on start. */
    reason: text("reason").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    /** Fixed on start: min(start + IMPERSONATION_TTL_MINUTES, the Admin's session expiry). */
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    endReason: text("end_reason").$type<ImpersonationEndReason>(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    // At most one open impersonation per Admin session (no nesting).
    uniqueIndex("impersonations_open_session")
      .on(table.sessionId)
      .where(sql`${table.endedAt} is null`),
    index("idx_impersonations_target_started").on(
      table.targetUserId,
      table.startedAt,
    ),
    index("idx_impersonations_admin_started").on(
      table.adminUserId,
      table.startedAt,
    ),
  ],
);

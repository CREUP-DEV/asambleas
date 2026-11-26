import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * How far an account has seen its notices («Avisos», GET /api/me/notices):
 * one mark per account, never one per notice. The notices newer than
 * `seenAt` are the new ones the sidebar counts. Opening the panel moves
 * it to the newest notice shown (PUT /api/me/notices/seen), never back
 * and never past the present; nothing is written while an Admin acts as
 * the account. Like the read marks, the mark is the account's own, which
 * a member may share among several people. The row goes with the account.
 */
export const noticeSeen = pgTable("notice_seen", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  seenAt: timestamp("seen_at", { withTimezone: true, mode: "date" }).notNull(),
});

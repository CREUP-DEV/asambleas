import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { cuid } from "./common";
import { users } from "./auth";
import { amendments } from "./amendment";

/**
 * Private notes of an account on an amendment it reads, about the whole
 * amendment (user's decision of 2026-11-17: an amendment is short, and its
 * diff changes with the view, so no note is anchored to a stretch of it).
 *
 * Like the notes on a document, they belong to the account, which a member
 * may share among several people: no other account reads them (an Admin
 * acting as the account is that account), and their text is never written
 * to the activity. Rows go with the account or the amendment.
 */
export const amendmentNotes = pgTable(
  "amendment_notes",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amendmentId: text("amendment_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    index("idx_amendment_notes_user_amendment").on(
      table.userId,
      table.amendmentId,
    ),
    index("idx_amendment_notes_amendment").on(table.amendmentId),
  ],
);

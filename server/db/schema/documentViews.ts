import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { documents } from "./document";

/**
 * How long each account had a published document open, for the statistics
 * (stats:view; server/utils/domain/documentViews.ts). One row per account,
 * document and day (Europe/Madrid): `views` counts the times it was opened,
 * `seconds` the time it was on screen with someone at it (the page beats
 * while it is visible and used, and the server never takes more than the
 * time since the last beat). Nothing is recorded while an Admin acts as the
 * account. Rows go with the account or the document.
 */
export const documentViews = pgTable(
  "document_views",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    views: integer("views").notNull().default(0),
    seconds: integer("seconds").notNull().default(0),
    firstViewedAt: timestamp("first_viewed_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    lastViewedAt: timestamp("last_viewed_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.documentId, table.day] }),
    index("idx_document_views_document").on(table.documentId),
  ],
);

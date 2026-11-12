import {
  pgTable,
  text,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { documents } from "./document";
import { amendments } from "./amendment";

/**
 * What an account marked as read, by hand: opening a document or an
 * amendment never marks it. `revision` is what the account read
 * (server/utils/domain/reading.ts: the published text or PDF of a document,
 * the operations and justification of an amendment); when the current one
 * differs, the mark reads as "changed since". Rows go with the account, the
 * document or the amendment.
 *
 * The marks belong to the account, which a member may share among several
 * people: only the account changes them, and only the statistics
 * (stats:view, server/utils/domain/stats.ts) read another account's.
 */
export const documentReads = pgTable(
  "document_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.documentId] }),
    index("idx_document_reads_document").on(table.documentId),
  ],
);

export const amendmentReads = pgTable(
  "amendment_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amendmentId: text("amendment_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.amendmentId] }),
    index("idx_amendment_reads_amendment").on(table.amendmentId),
  ],
);

import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { cuid } from "./common";
import { users } from "./auth";
import { documents } from "./document";

/**
 * Private notes of an account on a published document: about the whole
 * document (no anchor), or on a stretch of one block of its text.
 *
 * An anchored note keeps the block, the stretch as character offsets into
 * the block's text and the text it covered (`quote`). Nothing here follows
 * the document: when the text is published again and the stretch is no
 * longer where it was, readers look the quote up in the block, and a note
 * that cannot be placed stays listed with its quote.
 *
 * The notes belong to the account, which a member may share among several
 * people: no other account reads them (an Admin acting as the account is
 * that account), and their text is never written to the activity. Rows go
 * with the account or the document.
 */
export const documentNotes = pgTable(
  "document_notes",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** The block it is on; null for a note about the whole document. */
    blockId: text("block_id"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    /** The text the stretch covered when the note was written. */
    quote: text("quote"),
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
    index("idx_document_notes_user_document").on(
      table.userId,
      table.documentId,
    ),
    index("idx_document_notes_document").on(table.documentId),
  ],
);

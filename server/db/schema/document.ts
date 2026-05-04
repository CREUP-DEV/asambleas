import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  check,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { agendaItems } from "./agendaItem";
import { users } from "./auth";
import { amendments } from "./amendment";

export const documentTypeEnum = pgEnum("document_type", ["platform", "pdf"]);

export const documentStatusEnum = pgEnum("document_status", [
  "draft",
  "pending_review",
  "accepted",
]);

export interface ContentHistoryEntry {
  contentHash: string;
  amendmentId: string;
  type: "formal" | "accepted_proponent" | "approved_vote";
  incorporatedAt: string;
}

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    agendaItemId: text("agenda_item_id")
      .notNull()
      .references(() => agendaItems.id, { onDelete: "cascade" }),
    type: documentTypeEnum("type").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    contentVersion: text("content_version").notNull().default(""),
    contentHistory: jsonb("content_history")
      .$type<ContentHistoryEntry[]>()
      .default(sql`'[]'::jsonb`),
    fileUrl: text("file_url"),
    submittedBy: text("submitted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    proponentId: text("proponent_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: documentStatusEnum("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    check(
      "chk_documents_content",
      sql`(${table.type} = 'platform' AND ${table.content} IS NOT NULL) OR (${table.type} = 'pdf' AND ${table.fileUrl} IS NOT NULL)`,
    ),
    index("idx_documents_agenda_item_id").on(table.agendaItemId),
    index("idx_documents_status").on(table.status),
    index("idx_documents_submitted_by").on(table.submittedBy),
  ],
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  agendaItem: one(agendaItems, {
    fields: [documents.agendaItemId],
    references: [agendaItems.id],
  }),
  submittedByUser: one(users, {
    fields: [documents.submittedBy],
    references: [users.id],
    relationName: "document_submitted_by",
  }),
  proponent: one(users, {
    fields: [documents.proponentId],
    references: [users.id],
    relationName: "document_proponent",
  }),
  amendments: many(amendments),
}));

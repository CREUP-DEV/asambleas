import { pgTable, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { documents } from "./document";
import { users } from "./auth";

export const amendmentTypeEnum = pgEnum("amendment_type", [
  "regular",
  "formal",
]);

export const amendmentStatusEnum = pgEnum("amendment_status", [
  "draft",
  "pending_review",
  "rejected_secretaria",
  "formal",
  "accepted_secretaria",
  "accepted_proponent",
  "rejected_proponent",
  "approved_vote",
  "rejected_vote",
]);

export const amendments = pgTable(
  "amendments",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contentPatch: text("content_patch").notNull(),
    baseContentVersion: text("base_content_version").notNull(),
    justification: text("justification").notNull(),
    type: amendmentTypeEnum("type").notNull().default("regular"),
    status: amendmentStatusEnum("status").notNull().default("draft"),
    // Self-referencing FK added via raw SQL in migration:
    // ALTER TABLE amendments ADD CONSTRAINT fk_amendments_parent
    //   FOREIGN KEY (parent_amendment_id) REFERENCES amendments(id) ON DELETE CASCADE;
    parentAmendmentId: text("parent_amendment_id"),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    }),
    secretariaReviewedAt: timestamp("secretaria_reviewed_at", {
      withTimezone: true,
      mode: "date",
    }),
    proponentDecidedAt: timestamp("proponent_decided_at", {
      withTimezone: true,
      mode: "date",
    }),
    voteRecordedAt: timestamp("vote_recorded_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    index("idx_amendments_document_id").on(table.documentId),
    index("idx_amendments_submitted_by").on(table.submittedBy),
    index("idx_amendments_status").on(table.status),
    index("idx_amendments_parent_amendment_id").on(table.parentAmendmentId),
  ],
);

export const amendmentsRelations = relations(amendments, ({ one, many }) => ({
  document: one(documents, {
    fields: [amendments.documentId],
    references: [documents.id],
  }),
  author: one(users, {
    fields: [amendments.submittedBy],
    references: [users.id],
  }),
  parent: one(amendments, {
    fields: [amendments.parentAmendmentId],
    references: [amendments.id],
    relationName: "amendment_chain",
  }),
  children: many(amendments, {
    relationName: "amendment_chain",
  }),
}));

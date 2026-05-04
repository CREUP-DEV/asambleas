import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { assemblies } from "./assembly";
import { documents } from "./document";

export const agendaItems = pgTable(
  "agenda_items",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    // Self-referencing FK added via raw SQL in migration:
    // ALTER TABLE agenda_items ADD CONSTRAINT fk_agenda_items_parent
    //   FOREIGN KEY (parent_id) REFERENCES agenda_items(id) ON DELETE CASCADE;
    parentId: text("parent_id"),
    title: text("title").notNull(),
    order: integer("order").notNull().default(0),
    allowDocumentSubmission: boolean("allow_document_submission")
      .notNull()
      .default(false),
    documentSubmissionDeadline: timestamp("document_submission_deadline", {
      withTimezone: true,
      mode: "date",
    }),
    allowAmendments: boolean("allow_amendments").notNull().default(false),
    amendmentDeadline: timestamp("amendment_deadline", {
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
    index("idx_agenda_items_assembly_id").on(table.assemblyId),
    index("idx_agenda_items_parent_id").on(table.parentId),
  ],
);

export const agendaItemsRelations = relations(agendaItems, ({ one, many }) => ({
  assembly: one(assemblies, {
    fields: [agendaItems.assemblyId],
    references: [assemblies.id],
  }),
  parent: one(agendaItems, {
    fields: [agendaItems.parentId],
    references: [agendaItems.id],
    relationName: "agenda_item_children",
  }),
  children: many(agendaItems, {
    relationName: "agenda_item_children",
  }),
  documents: many(documents),
}));

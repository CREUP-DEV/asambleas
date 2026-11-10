import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  foreignKey,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { assemblies } from "./assembly";
import { documents } from "./document";
import type { DocumentKind } from "../../../shared/constants/domain";

/** Recursive agenda tree. Loaded flat and built client-side. */
export const agendaItems = pgTable(
  "agenda_items",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    description: text("description"),
    order: integer("order").notNull().default(0),
    /** Members may present documents under this point (resolutions, motions). */
    acceptsSubmissions: boolean("accepts_submissions").notNull().default(false),
    /**
     * The document kinds members may present here while `acceptsSubmissions`
     * is on. Empty means every kind.
     */
    submissionKinds: jsonb("submission_kinds")
      .$type<DocumentKind[]>()
      .notNull()
      .default([]),
    /**
     * Set on an automatic sub-item: the one the server created for this
     * document when it was presented under an item that accepts submissions.
     * Its title follows the document's until `titleCustom`.
     */
    generatedForDocumentId: text("generated_for_document_id").references(
      (): AnyPgColumn => documents.id,
      { onDelete: "set null" },
    ),
    /** A manager renamed the automatic sub-item: it keeps its own title. */
    titleCustom: boolean("title_custom").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    foreignKey({
      name: "fk_agenda_items_parent",
      columns: [table.parentId],
      foreignColumns: [table.id],
    }).onDelete("cascade"),
    index("idx_agenda_items_assembly_id").on(table.assemblyId),
    index("idx_agenda_items_parent_id").on(table.parentId),
    index("idx_agenda_items_generated_for").on(table.generatedForDocumentId),
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
  children: many(agendaItems, { relationName: "agenda_item_children" }),
  documents: many(documents),
}));

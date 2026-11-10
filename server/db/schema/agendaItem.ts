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
    /**
     * Set on an item that was the automatic sub-item of this document and
     * stayed, as an ordinary item, when the document moved away: it may
     * still carry the document's title, so it stays hidden from whoever
     * cannot see that document (titleDocumentId). Never set together with
     * `generatedForDocumentId`; cleared when the document is deleted (see
     * `titleWithheld`) or a manager gives the item a new title.
     */
    hiddenWithDocumentId: text("hidden_with_document_id").references(
      (): AnyPgColumn => documents.id,
      { onDelete: "set null" },
    ),
    /**
     * The item carries the title of a document that was deleted before
     * everyone could see it (a draft, a submission under review), whose
     * automatic sub-item it was: only document managers read its title and
     * description until one of them gives it a new title.
     */
    titleWithheld: boolean("title_withheld").notNull().default(false),
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
    index("idx_agenda_items_hidden_with").on(table.hiddenWithDocumentId),
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

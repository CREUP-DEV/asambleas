import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { assemblies } from "./assembly";
import { documents } from "./document";

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

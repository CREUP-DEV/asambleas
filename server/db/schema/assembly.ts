import {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  check,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { agendaItems } from "./agendaItem";

export const assemblyTypeEnum = pgEnum("assembly_type", ["AGO", "AGE", "AGET"]);

export const assemblyStatusEnum = pgEnum("assembly_status", [
  "draft",
  "provisional",
  "definitive",
]);

export const assemblies = pgTable(
  "assemblies",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    number: integer("number").notNull().unique(),
    type: assemblyTypeEnum("type").notNull(),
    status: assemblyStatusEnum("status").notNull().default("draft"),
    startDate: timestamp("start_date", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    endDate: timestamp("end_date", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    location: text("location").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    check("chk_assemblies_dates", sql`${table.endDate} >= ${table.startDate}`),
    index("idx_assemblies_status").on(table.status),
    index("idx_assemblies_number").on(table.number),
  ],
);

export const assembliesRelations = relations(assemblies, ({ many }) => ({
  agendaItems: many(agendaItems),
}));

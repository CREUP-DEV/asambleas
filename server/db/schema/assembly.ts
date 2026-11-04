import {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  check,
  index,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { users } from "./auth";
import { agendaItems } from "./agendaItem";
import { documents } from "./document";
import {
  ASSEMBLY_STATUSES,
  DEFAULT_ASSEMBLY_SETTINGS,
  MILESTONE_KEYS,
  type AssemblySettings,
} from "../../../shared/constants/domain";
import { ALL_ASSEMBLY_TYPES } from "../../../shared/constants/assemblyTypes";

export const assemblyTypeEnum = pgEnum(
  "assembly_type",
  ALL_ASSEMBLY_TYPES as ["AGO", "AGE", "AGET"],
);
export const assemblyStatusEnum = pgEnum("assembly_status", ASSEMBLY_STATUSES);
export const milestoneKeyEnum = pgEnum("milestone_key", MILESTONE_KEYS);

export const assemblies = pgTable(
  "assemblies",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    // Each assembly type keeps its own counter (34 AGE and 34 AGET coexist).
    number: integer("number").notNull(),
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
    /** Free text opening the convocatoria, written by Secretaría. */
    convocationIntro: text("convocation_intro"),
    agendaFinalizedAt: timestamp("agenda_finalized_at", {
      withTimezone: true,
      mode: "date",
    }),
    settings: jsonb("settings")
      .$type<AssemblySettings>()
      .notNull()
      .default(DEFAULT_ASSEMBLY_SETTINGS),
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
    uniqueIndex("assemblies_type_number_unique").on(table.type, table.number),
    index("idx_assemblies_status").on(table.status),
    index("idx_assemblies_start_date").on(table.startDate),
  ],
);

/** Dated milestones of the assembly calendar (deadlines, publications). */
export const assemblyMilestones = pgTable(
  "assembly_milestones",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    key: milestoneKeyEnum("key").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("assembly_milestones_key_unique").on(
      table.assemblyId,
      table.key,
    ),
  ],
);

/** What the Mesa is debating right now. One row per assembly. */
export const liveState = pgTable("live_state", {
  assemblyId: text("assembly_id")
    .primaryKey()
    .references(() => assemblies.id, { onDelete: "cascade" }),
  agendaItemId: text("agenda_item_id").references(() => agendaItems.id, {
    onDelete: "set null",
  }),
  documentId: text("document_id").references(() => documents.id, {
    onDelete: "set null",
  }),
  amendmentId: text("amendment_id"),
  voteId: text("vote_id"),
  message: text("message"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`now()`),
});

export const assembliesRelations = relations(assemblies, ({ many, one }) => ({
  agendaItems: many(agendaItems),
  documents: many(documents),
  milestones: many(assemblyMilestones),
  liveState: one(liveState, {
    fields: [assemblies.id],
    references: [liveState.assemblyId],
  }),
}));

export const assemblyMilestonesRelations = relations(
  assemblyMilestones,
  ({ one }) => ({
    assembly: one(assemblies, {
      fields: [assemblyMilestones.assemblyId],
      references: [assemblies.id],
    }),
  }),
);

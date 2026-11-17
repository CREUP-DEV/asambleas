import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { cuid } from "./common";
import { users } from "./auth";
import { assemblies } from "./assembly";
import { agendaItems } from "./agendaItem";
import { amendments } from "./amendment";
import { impersonations } from "./impersonation";
import { CONTROL_SHEET_MANUAL_RESULTS } from "../../../shared/constants/domain";

/**
 * The control sheet's old «Posición CEA», removed from the platform: the
 * enum and the three cea_position columns below are no longer read nor
 * written, and stay only until the next release drops them (a release must
 * still run on the schema of the next one, AGENTS.md).
 */
export const ceaPositionEnum = pgEnum("cea_position", [
  "accept",
  "transact",
  "reject",
  "lapse",
]);
export const controlSheetResultEnum = pgEnum(
  "control_sheet_result",
  CONTROL_SHEET_MANUAL_RESULTS,
);

const at = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/**
 * What the control sheet (hoja de control) notes about an agenda item:
 * whether an item without documents is listed, a result by hand, the Mesa's
 * treated mark and the shared observations. A row exists once someone
 * writes something; no row reads as nothing written.
 *
 * Each field edited on its own carries its own lock token, set only by its
 * own writes (`listedUpdatedAt`, `resultUpdatedAt`, `progressUpdatedAt`,
 * `observationsUpdatedAt`), so an observation saved while the Mesa marks the
 * item never makes the other side stale. `updatedAt` is bookkeeping and is
 * never compared. The row's own id names it in the history and the live
 * stream, which never tells which item someone was writing about.
 */
export const controlSheetItems = pgTable(
  "control_sheet_items",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    agendaItemId: text("agenda_item_id")
      .notNull()
      .references(() => agendaItems.id, { onDelete: "cascade" }),
    /** An item without documents shown on the sheet (one that is voted). */
    listed: boolean("listed").notNull().default(false),
    listedUpdatedAt: at("listed_updated_at"),
    manualResult: controlSheetResultEnum("manual_result"),
    resultUpdatedAt: at("result_updated_at"),
    /** The Mesa marked it treated by hand. */
    treatedAt: at("treated_at"),
    treatedByUserId: text("treated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    progressUpdatedAt: at("progress_updated_at"),
    observations: text("observations").notNull().default(""),
    observationsUpdatedAt: at("observations_updated_at"),
    observationsUpdatedByUserId: text(
      "observations_updated_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("control_sheet_items_item_unique").on(table.agendaItemId),
    index("idx_control_sheet_items_assembly").on(table.assemblyId),
  ],
);

/**
 * What the control sheet notes about an amendment: the CEA's position, the
 * Mesa's treated mark and the shared observations, each with its own lock
 * token, like control_sheet_items. Never on a draft.
 */
export const controlSheetAmendments = pgTable(
  "control_sheet_amendments",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    amendmentId: text("amendment_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    /** Unused, waiting to be dropped (see ceaPositionEnum). */
    ceaPosition: ceaPositionEnum("cea_position"),
    ceaPositionUpdatedAt: at("cea_position_updated_at"),
    ceaPositionUpdatedByUserId: text(
      "cea_position_updated_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    treatedAt: at("treated_at"),
    treatedByUserId: text("treated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    treatedUpdatedAt: at("treated_updated_at"),
    observations: text("observations").notNull().default(""),
    observationsUpdatedAt: at("observations_updated_at"),
    observationsUpdatedByUserId: text(
      "observations_updated_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("control_sheet_amendments_amendment_unique").on(
      table.amendmentId,
    ),
    index("idx_control_sheet_amendments_assembly").on(table.assemblyId),
  ],
);

/**
 * Every text saved as the observations of a sheet row, with who and when,
 * so the sheet shows who wrote what and an earlier text can be brought
 * back. The text lives only here and on the row, never in an event, and
 * goes with its row. Exactly one of the two row columns is set.
 */
export const controlSheetObservationRevisions = pgTable(
  "control_sheet_observation_revisions",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    itemRowId: text("item_row_id").references(() => controlSheetItems.id, {
      onDelete: "cascade",
    }),
    amendmentRowId: text("amendment_row_id").references(
      () => controlSheetAmendments.id,
      { onDelete: "cascade" },
    ),
    text: text("text").notNull(),
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    impersonationId: text("impersonation_id").references(
      () => impersonations.id,
      { onDelete: "set null" },
    ),
    createdAt: at("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_control_sheet_revisions_item_row").on(
      table.itemRowId,
      table.createdAt,
    ),
    index("idx_control_sheet_revisions_amendment_row").on(
      table.amendmentRowId,
      table.createdAt,
    ),
    check(
      "control_sheet_revisions_one_row",
      sql`(${table.itemRowId} is null) <> (${table.amendmentRowId} is null)`,
    ),
  ],
);

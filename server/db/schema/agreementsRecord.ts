import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { assemblies } from "./assembly";

/**
 * The Secretaría's corrections to the acta de acuerdos (user's decision of
 * 2026-11-21: regenerated, with corrections per agreement). One row per
 * line it corrected, by the key the record gives the line
 * (shared/utils/agreementsRecord.ts: `item:<id>`, `doc:<id>`,
 * `group:<id>:<kind>:<result>`, `minutes:…`, `self`, or a header field such
 * as `secretary_name`). The record is built again from the votes and these
 * rows, so they survive every regeneration; a key no line has any longer is
 * kept and simply unused. `updatedAt` is the row's lock token.
 */
export const agreementRecordTexts = pgTable(
  "agreement_record_texts",
  {
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Its words for the line, without suffix; null keeps the proposal. */
    text: text("text"),
    /** The line is left out of the record. */
    omitted: boolean("omitted").notNull().default(false),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [primaryKey({ columns: [table.assemblyId, table.key] })],
);

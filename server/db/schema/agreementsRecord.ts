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
import { documents, documentVersions } from "./document";

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

/**
 * The signing of the acta de acuerdos (user's decisions of 2026-11-23): once
 * its own final vote approved it, the Secretaría makes the PDF to sign (the
 * clean consolidated text with the visible signature of whoever certifies,
 * read from the Intranet then and kept nowhere else), signs it with
 * AutoFirma or outside the platform and uploads it; the signed PDF then
 * leads the document for everyone. One row per record.
 *
 * - `preparedFile` is the stored name (upload directory, never served but
 *   to the Secretaría) of the last PDF made to sign, of `versionId`.
 * - `signedFileUrl` is the signed PDF everyone reads
 *   (/api/uploads/agreements/[filename]), of `signedVersionId`. A new
 *   version of the record (regenerated with a correction) takes it away:
 *   the record is signed again.
 * - `updatedAt` is the row's lock token.
 */
export const agreementRecordSignings = pgTable("agreement_record_signings", {
  documentId: text("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  versionId: text("version_id").references(() => documentVersions.id, {
    onDelete: "set null",
  }),
  preparedFile: text("prepared_file"),
  preparedAt: timestamp("prepared_at", { withTimezone: true, mode: "date" }),
  preparedByUserId: text("prepared_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  /** The prepared PDF carried the visible signature from the Intranet. */
  preparedWithImage: boolean("prepared_with_image").notNull().default(false),
  signedFileUrl: text("signed_file_url"),
  signedFileName: text("signed_file_name"),
  signedVersionId: text("signed_version_id").references(
    () => documentVersions.id,
    { onDelete: "set null" },
  ),
  signedAt: timestamp("signed_at", { withTimezone: true, mode: "date" }),
  signedByUserId: text("signed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`now()`),
});

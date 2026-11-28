import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
  jsonb,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { users } from "./auth";
import { assemblies } from "./assembly";
import { agendaItems } from "./agendaItem";
import { members } from "./member";
import { amendments } from "./amendment";
import type { Block } from "../../../shared/types/content";
import type {
  ConciliationPassage,
  PendingPassage,
} from "../../../shared/utils/content/pendingPassages";
import {
  ACCEPTED_AMENDMENT_RULES,
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  FORM_CORRECTION_STATUSES,
  DOCUMENT_STATUSES,
  MAJORITIES,
} from "../../../shared/constants/domain";

export const documentKindEnum = pgEnum("document_kind", DOCUMENT_KINDS);
export const documentFormatEnum = pgEnum("document_format", DOCUMENT_FORMATS);
export const documentStatusEnum = pgEnum("document_status", DOCUMENT_STATUSES);
export const majorityEnum = pgEnum("majority", MAJORITIES);
export const acceptedAmendmentRuleEnum = pgEnum(
  "accepted_amendment_rule",
  ACCEPTED_AMENDMENT_RULES,
);
export const versionKindEnum = pgEnum("document_version_kind", [
  "draft",
  "base",
  "consolidated",
]);

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    agendaItemId: text("agenda_item_id")
      .notNull()
      .references(() => agendaItems.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    kind: documentKindEnum("kind").notNull(),
    format: documentFormatEnum("format").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    /** Official reference such as "RES 012/2026", assigned on admission. */
    reference: text("reference"),
    status: documentStatusEnum("status").notNull().default("draft"),
    proponentMemberId: text("proponent_member_id").references(
      () => members.id,
      {
        onDelete: "set null",
      },
    ),
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    amendable: boolean("amendable").notNull().default(false),
    voted: boolean("voted").notNull().default(true),
    /**
     * «Se firma»: a signed PDF is made from its text (documentSigning).
     * Defaults from the kind; never for a document in `file` format.
     */
    signed: boolean("signed").notNull().default(false),
    majority: majorityEnum("majority").notNull().default("simple"),
    /**
     * What an amendment the presenter accepts becomes: incorporated without
     * a vote, or voted by the assembly. Defaults from the kind.
     */
    acceptedAmendments: acceptedAmendmentRuleEnum("accepted_amendments")
      .notNull()
      .default("vote"),
    /**
     * The Secretaría made the main presenter's answers to the amendments
     * public before their debate (positionsArePublic,
     * shared/utils/positions.ts). Cleared when it takes that back, which it
     * may only until the debate starts.
     */
    positionsPublishedAt: timestamp("positions_published_at", {
      withTimezone: true,
      mode: "date",
    }),
    positionsPublishedByUserId: text(
      "positions_published_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    /**
     * When the agenda item the document hangs from, the document or one of
     * its amendments first went into debate during the session: the
     * answers are public from then on, for good. Never cleared.
     */
    positionsDebateStartedAt: timestamp("positions_debate_started_at", {
      withTimezone: true,
      mode: "date",
    }),
    /**
     * When the Mesa first put the document itself on screen during the
     * session: the console marks it as projected. Never cleared.
     */
    firstProjectedAt: timestamp("first_projected_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Override of the assembly amendment window for this document. */
    amendmentsOpenAt: timestamp("amendments_open_at", {
      withTimezone: true,
      mode: "date",
    }),
    amendmentsCloseAt: timestamp("amendments_close_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Editable draft, before publication. */
    workingVersionId: text("working_version_id").references(
      (): AnyPgColumn => documentVersions.id,
      { onDelete: "set null" },
    ),
    /** Frozen at publication; amendments are anchored to it. */
    baseVersionId: text("base_version_id").references(
      (): AnyPgColumn => documentVersions.id,
      { onDelete: "set null" },
    ),
    /** Stored when the final text is approved. */
    consolidatedVersionId: text("consolidated_version_id").references(
      (): AnyPgColumn => documentVersions.id,
      { onDelete: "set null" },
    ),
    finalVoteId: text("final_vote_id"),
    fileUrl: text("file_url"),
    fileName: text("file_name"),
    /**
     * A document the platform writes itself: `agreements_record`, the acta
     * de acuerdos (shared/utils/agreementsRecord.ts), one per assembly, kept
     * in step with the votes until its own final vote. Null for every
     * document someone presents.
     */
    generated: text("generated").$type<"agreements_record">(),
    carriedFromDocumentId: text("carried_from_document_id").references(
      (): AnyPgColumn => documents.id,
      { onDelete: "set null" },
    ),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    }),
    /**
     * Internal deadline the Secretaría sets for documents it expects (CEA
     * reports, resolutions...). Drives the documentation tracking panel.
     */
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
    /** Last correction the Secretaría asked for (the document went back to draft). */
    correctionNote: text("correction_note"),
    correctionRequestedAt: timestamp("correction_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    publishedAt: timestamp("published_at", {
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
    uniqueIndex("documents_assembly_slug_unique").on(
      table.assemblyId,
      table.slug,
    ),
    index("idx_documents_agenda_item_id").on(table.agendaItemId),
    index("idx_documents_status").on(table.status),
    index("idx_documents_proponent").on(table.proponentMemberId),
    uniqueIndex("documents_generated_unique")
      .on(table.assemblyId, table.generated)
      .where(sql`${table.generated} is not null`),
  ],
);

/** Immutable snapshots of structured content (the draft is updated in place). */
/**
 * Members presenting a document jointly with its main presenter
 * (`documents.proponentMemberId`). They prepare the text with it and see what
 * it decides; only the main presenter answers the amendments.
 */
export const documentProponents = pgTable(
  "document_proponents",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("document_proponents_unique").on(
      table.documentId,
      table.memberId,
    ),
    index("idx_document_proponents_member").on(table.memberId),
  ],
);

/**
 * Images stored for a document's text (image blocks point to them by id,
 * BlockImage.asset). Files live in the upload directory under images/, named
 * by id; rows go with the document, and its files are removed with it.
 * Draft edits never remove one: a published version may still show it.
 */
export const documentImages = pgTable(
  "document_images",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    documentId: text("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_document_images_document").on(table.documentId)],
);

/**
 * The PDFs of a `file` document: the current one (`documents.fileUrl` ends in
 * its `storedName`) and the ones it replaced once published, kept because
 * delegates may have read them. A PDF replaced before publication goes with
 * its row. Files live in the upload directory under their stored name; rows
 * go with the document, and its files are removed with it. Only document
 * managers read a replaced one (`replacedAt` set).
 */
export const documentFiles = pgTable(
  "document_files",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    documentId: text("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    /** Random name on disk (STORED_PDF_NAME), never shown. */
    storedName: text("stored_name").notNull(),
    /** Name of the file as uploaded. */
    fileName: text("file_name").notNull(),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    /** When another PDF replaced it after publication; null while current. */
    replacedAt: timestamp("replaced_at", { withTimezone: true, mode: "date" }),
    replacedByUserId: text("replaced_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("document_files_stored_name_unique").on(table.storedName),
    index("idx_document_files_document").on(table.documentId),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    documentId: text("document_id")
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    kind: versionKindEnum("kind").notNull(),
    blocks: jsonb("blocks").$type<Block[]>().notNull(),
    contentHash: text("content_hash").notNull(),
    note: text("note"),
    /**
     * A consolidated version corrected in form after the final vote: the
     * one it replaced (documentFormCorrections). Null for the voted one.
     */
    replacesVersionId: text("replaces_version_id").references(
      (): AnyPgColumn => documentVersions.id,
      { onDelete: "set null" },
    ),
    /**
     * A consolidated version approved pending conciliation (user's
     * decisions of 2026-11-21; shared/utils/content/pendingPassages.ts):
     * the passages where approved amendments still collide, carrying the
     * automatic proposal. Null or empty: the text is final.
     */
    pendingPassages: jsonb("pending_passages").$type<PendingPassage[]>(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
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
    uniqueIndex("document_versions_number_unique").on(
      table.documentId,
      table.number,
    ),
  ],
);

export const formCorrectionStatusEnum = pgEnum(
  "form_correction_status",
  FORM_CORRECTION_STATUSES,
);

/**
 * Corrections of form to an approved text (user's decisions of
 * 2026-11-21). Each one is the whole corrected text over the consolidated
 * version it was made on (`fromVersionId`) and a reason; once applied, the
 * new consolidated version it gave (`resultVersionId`) replaces that one,
 * with no annex. The Secretaría's and the Mesa's are applied when made; a
 * presenter's waits for the Secretaría.
 */
export const documentFormCorrections = pgTable(
  "document_form_corrections",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    fromVersionId: text("from_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    blocks: jsonb("blocks").$type<Block[]>().notNull(),
    contentHash: text("content_hash").notNull(),
    reason: text("reason").notNull(),
    status: formCorrectionStatusEnum("status").notNull().default("pending"),
    /** Who made it, as the record names them: the office, or a presenter. */
    madeAs: text("made_as")
      .$type<"secretaria" | "mesa" | "authorized" | "presenter">()
      .notNull(),
    proposedByUserId: text("proposed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resultVersionId: text("result_version_id").references(
      () => documentVersions.id,
      { onDelete: "set null" },
    ),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decisionNote: text("decision_note"),
    /**
     * A conciliation of a passage left pending by the final vote (user's
     * decisions of 2026-11-21): its wording over the base. `blocks` is then
     * the whole text rebuilt with it. Null for a correction of form.
     */
    passage: jsonb("passage").$type<ConciliationPassage>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    index("document_form_corrections_document_idx").on(
      table.documentId,
      table.createdAt,
    ),
  ],
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  assembly: one(assemblies, {
    fields: [documents.assemblyId],
    references: [assemblies.id],
  }),
  agendaItem: one(agendaItems, {
    fields: [documents.agendaItemId],
    references: [agendaItems.id],
  }),
  proponent: one(members, {
    fields: [documents.proponentMemberId],
    references: [members.id],
  }),
  submittedBy: one(users, {
    fields: [documents.submittedByUserId],
    references: [users.id],
  }),
  versions: many(documentVersions),
  amendments: many(amendments),
}));

export const documentVersionsRelations = relations(
  documentVersions,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentVersions.documentId],
      references: [documents.id],
    }),
  }),
);

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
import {
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  MAJORITIES,
} from "../../../shared/constants/domain";

export const documentKindEnum = pgEnum("document_kind", DOCUMENT_KINDS);
export const documentFormatEnum = pgEnum("document_format", DOCUMENT_FORMATS);
export const documentStatusEnum = pgEnum("document_status", DOCUMENT_STATUSES);
export const majorityEnum = pgEnum("majority", MAJORITIES);
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
    proponentMemberId: text("proponent_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    amendable: boolean("amendable").notNull().default(false),
    voted: boolean("voted").notNull().default(true),
    majority: majorityEnum("majority").notNull().default("simple"),
    /** Override of the assembly amendment window for this document. */
    amendmentsOpenAt: timestamp("amendments_open_at", { withTimezone: true, mode: "date" }),
    amendmentsCloseAt: timestamp("amendments_close_at", { withTimezone: true, mode: "date" }),
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
    carriedFromDocumentId: text("carried_from_document_id").references(
      (): AnyPgColumn => documents.id,
      { onDelete: "set null" },
    ),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("documents_assembly_slug_unique").on(table.assemblyId, table.slug),
    index("idx_documents_agenda_item_id").on(table.agendaItemId),
    index("idx_documents_status").on(table.status),
    index("idx_documents_proponent").on(table.proponentMemberId),
  ],
);

/** Immutable snapshots of structured content (the draft is updated in place). */
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
    uniqueIndex("document_versions_number_unique").on(table.documentId, table.number),
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

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}));

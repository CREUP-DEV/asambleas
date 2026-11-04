import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  pgEnum,
  index,
  jsonb,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { cuid } from "./common";
import { users } from "./auth";
import { members } from "./member";
import { documents, documentVersions } from "./document";
import type { AmendmentOp } from "../../../shared/types/content";
import {
  ACCEPTANCE_DECISIONS,
  ACCEPTANCE_ROLES,
  ADMISSION_STATUSES,
  AMENDMENT_KINDS,
  AMENDMENT_STATUSES,
  APPROVAL_METHODS,
  PROPONENT_POSITIONS,
  RELATION_KINDS,
} from "../../../shared/constants/domain";

export const amendmentKindEnum = pgEnum("amendment_kind", AMENDMENT_KINDS);
export const amendmentStatusEnum = pgEnum(
  "amendment_status",
  AMENDMENT_STATUSES,
);
export const admissionStatusEnum = pgEnum(
  "admission_status",
  ADMISSION_STATUSES,
);
export const approvalMethodEnum = pgEnum("approval_method", APPROVAL_METHODS);
export const proponentPositionEnum = pgEnum(
  "proponent_position",
  PROPONENT_POSITIONS,
);
export const acceptanceDecisionEnum = pgEnum(
  "acceptance_decision",
  ACCEPTANCE_DECISIONS,
);
export const acceptanceRoleEnum = pgEnum("acceptance_role", ACCEPTANCE_ROLES);
export const relationKindEnum = pgEnum(
  "amendment_relation_kind",
  RELATION_KINDS,
);

export interface AmendmentMeta {
  /** Set for global term replacements ("y en lo sucesivo"). */
  globalReplace?: { find: string; replace: string };
}

/**
 * An amendment is a set of operations anchored to the document's frozen base
 * version. No modified copy of the text is ever stored.
 */
export const amendments = pgTable(
  "amendments",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    baseVersionId: text("base_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    /** Running number per document, assigned on submission. */
    number: integer("number"),
    /** Counter per presenting member within the document. */
    memberSeq: integer("member_seq"),
    /** Display code, e.g. "CEUM 4" or "T1". */
    code: text("code"),
    kind: amendmentKindEnum("kind").notNull().default("partial"),
    status: amendmentStatusEnum("status").notNull().default("draft"),
    admission: admissionStatusEnum("admission").notNull().default("pending"),
    /** Submitted after the window closed. Computed by the server. */
    late: boolean("late").notNull().default(false),
    ops: jsonb("ops").$type<AmendmentOp[]>().notNull(),
    meta: jsonb("meta").$type<AmendmentMeta>().notNull().default({}),
    justification: text("justification").notNull().default(""),
    /** Sort key by position in the base text. */
    positionKey: real("position_key").notNull().default(0),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    }),
    approvalMethod: approvalMethodEnum("approval_method"),
    outcomeVoteId: text("outcome_vote_id"),
    outcomeNote: text("outcome_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    index("idx_amendments_document_id").on(table.documentId),
    index("idx_amendments_status").on(table.status),
    uniqueIndex("amendments_document_number_unique").on(
      table.documentId,
      table.number,
    ),
  ],
);

/** Presenting members. Joint amendments have several. */
export const amendmentAuthors = pgTable(
  "amendment_authors",
  {
    amendmentId: text("amendment_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.amendmentId, table.memberId] }),
    index("idx_amendment_authors_member").on(table.memberId),
  ],
);

/** Parents of a transactional amendment (1..N). */
export const amendmentSources = pgTable(
  "amendment_sources",
  {
    transactionalId: text("transactional_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.transactionalId, table.sourceId] }),
    index("idx_amendment_sources_source").on(table.sourceId),
  ],
);

/** Each party's acceptance of a transactional amendment. */
export const amendmentAcceptances = pgTable(
  "amendment_acceptances",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    amendmentId: text("amendment_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    role: acceptanceRoleEnum("role").notNull(),
    decision: acceptanceDecisionEnum("decision").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    recordedByUserId: text("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("amendment_acceptances_party_unique").on(
      table.amendmentId,
      table.memberId,
    ),
  ],
);

/** The document proponent's position on an amendment. */
export const amendmentPositions = pgTable("amendment_positions", {
  amendmentId: text("amendment_id")
    .primaryKey()
    .references(() => amendments.id, { onDelete: "cascade" }),
  position: proponentPositionEnum("position").notNull().default("pending"),
  comment: text("comment"),
  decidedByUserId: text("decided_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`now()`),
});

/** Annotated relations between amendments (incompatible, duplicate...). */
export const amendmentRelations = pgTable(
  "amendment_relations",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    fromId: text("from_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    toId: text("to_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    kind: relationKindEnum("kind").notNull(),
    note: text("note"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("amendment_relations_unique").on(
      table.fromId,
      table.toId,
      table.kind,
    ),
    index("idx_amendment_relations_to").on(table.toId),
  ],
);

export const amendmentsRelations = relations(amendments, ({ one, many }) => ({
  document: one(documents, {
    fields: [amendments.documentId],
    references: [documents.id],
  }),
  baseVersion: one(documentVersions, {
    fields: [amendments.baseVersionId],
    references: [documentVersions.id],
  }),
  authors: many(amendmentAuthors),
  sources: many(amendmentSources, { relationName: "transactional_sources" }),
  derived: many(amendmentSources, { relationName: "source_transactionals" }),
  acceptances: many(amendmentAcceptances),
  position: one(amendmentPositions, {
    fields: [amendments.id],
    references: [amendmentPositions.amendmentId],
  }),
  submittedBy: one(users, {
    fields: [amendments.submittedByUserId],
    references: [users.id],
  }),
}));

export const amendmentAuthorsRelations = relations(
  amendmentAuthors,
  ({ one }) => ({
    amendment: one(amendments, {
      fields: [amendmentAuthors.amendmentId],
      references: [amendments.id],
    }),
    member: one(members, {
      fields: [amendmentAuthors.memberId],
      references: [members.id],
    }),
  }),
);

export const amendmentSourcesRelations = relations(
  amendmentSources,
  ({ one }) => ({
    transactional: one(amendments, {
      fields: [amendmentSources.transactionalId],
      references: [amendments.id],
      relationName: "transactional_sources",
    }),
    source: one(amendments, {
      fields: [amendmentSources.sourceId],
      references: [amendments.id],
      relationName: "source_transactionals",
    }),
  }),
);

export const amendmentAcceptancesRelations = relations(
  amendmentAcceptances,
  ({ one }) => ({
    amendment: one(amendments, {
      fields: [amendmentAcceptances.amendmentId],
      references: [amendments.id],
    }),
    member: one(members, {
      fields: [amendmentAcceptances.memberId],
      references: [members.id],
    }),
  }),
);

export const amendmentPositionsRelations = relations(
  amendmentPositions,
  ({ one }) => ({
    amendment: one(amendments, {
      fields: [amendmentPositions.amendmentId],
      references: [amendments.id],
    }),
  }),
);

export const amendmentRelationsRelations = relations(
  amendmentRelations,
  ({ one }) => ({
    from: one(amendments, {
      fields: [amendmentRelations.fromId],
      references: [amendments.id],
    }),
    to: one(amendments, {
      fields: [amendmentRelations.toId],
      references: [amendments.id],
    }),
  }),
);

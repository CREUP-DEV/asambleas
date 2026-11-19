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
  AMENDMENT_STATUSES,
  APPROVAL_METHODS,
  PROPONENT_POSITIONS,
  RELATION_KINDS,
  type AmendmentKind,
} from "../../../shared/constants/domain";

/**
 * The kinds of amendment (AMENDMENT_KINDS). The enum still holds
 * `totality_return` and `totality_alternative`, the amendments to the whole
 * text, removed from the platform (no amendment was ever stored with them):
 * Postgres cannot drop an enum value, and the code never writes them.
 */
export const amendmentKindEnum = pgEnum("amendment_kind", [
  "partial",
  "formal",
  "totality_return",
  "totality_alternative",
  "transactional",
]);
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
    // Typed as the kinds still in use: the enum keeps two removed ones.
    kind: amendmentKindEnum("kind")
      .$type<AmendmentKind>()
      .notNull()
      .default("partial"),
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
    /**
     * Secretaría checked the form of the submitted amendment. On-time
     * amendments are admitted at the same time; late ones still need the
     * Mesa's admission decision.
     */
    validatedAt: timestamp("validated_at", {
      withTimezone: true,
      mode: "date",
    }),
    validatedByUserId: text("validated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Visible to everyone who can see the document. Until then only its
     * authors, the Secretaría and the Mesa see it. Set by the Secretaría,
     * when validating or later.
     */
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Last correction the Secretaría asked for (the amendment went back to draft). */
    correctionNote: text("correction_note"),
    correctionRequestedAt: timestamp("correction_requested_at", {
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
    // A code names one amendment of the document; the ones without a code
    // yet (not published) are distinct nulls.
    uniqueIndex("amendments_document_code_unique").on(
      table.documentId,
      table.code,
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

/**
 * Where an inclusion in a transactional stands (transactional_revisions):
 * waiting for its parties, then (proposed by a member) for the Secretaría;
 * applied, rejected by a party, or cancelled by whoever proposed it.
 */
export const transactionalRevisionStatusEnum = pgEnum(
  "transactional_revision_status",
  ["pending_parties", "pending_validation", "applied", "rejected", "cancelled"],
);

/**
 * A proposal to include amendments in an existing transactional, with its
 * new text (user's decision of 2026-11-19): every party of the new version
 * accepts it again (transactional_revision_acceptances); a rejection leaves
 * the transactional as it was. The version in force stays in `amendments`,
 * `amendment_sources` and `amendment_acceptances` until it is applied. At
 * most one open per transactional (partial unique index).
 */
export const transactionalRevisions = pgTable(
  "transactional_revisions",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    transactionalId: text("transactional_id")
      .notNull()
      .references(() => amendments.id, { onDelete: "cascade" }),
    proposedByUserId: text("proposed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** The member it was proposed for, null when the Mesa or the Secretaría did. */
    proposedAsMemberId: text("proposed_as_member_id").references(
      () => members.id,
      { onDelete: "set null" },
    ),
    /** Applied at once when its parties accept (the Mesa's, the Secretaría's). */
    staffProposed: boolean("staff_proposed").notNull().default(false),
    addedSourceIds: text("added_source_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ops: jsonb("ops").$type<AmendmentOp[]>().notNull(),
    justification: text("justification").notNull().default(""),
    status: transactionalRevisionStatusEnum("status")
      .notNull()
      .default("pending_parties"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("idx_transactional_revisions_transactional").on(
      table.transactionalId,
    ),
    uniqueIndex("transactional_revisions_open_unique")
      .on(table.transactionalId)
      .where(sql`status in ('pending_parties', 'pending_validation')`),
  ],
);

/** Each party's answer to an inclusion (transactional_revisions). */
export const transactionalRevisionAcceptances = pgTable(
  "transactional_revision_acceptances",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    revisionId: text("revision_id")
      .notNull()
      .references(() => transactionalRevisions.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    decision: acceptanceDecisionEnum("decision").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    recordedByUserId: text("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("transactional_revision_acceptances_party_unique").on(
      table.revisionId,
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

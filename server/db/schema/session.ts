import {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { cuid } from "./common";
import { users } from "./auth";
import { members } from "./member";
import { assemblies } from "./assembly";
import {
  DECISION_KINDS,
  DECISION_METHODS,
  VOTE_METHODS,
  VOTE_RESULTS,
  VOTE_SUBJECTS,
} from "../../../shared/constants/domain";
import { majorityEnum } from "./document";

export const voteMethodEnum = pgEnum("vote_method", VOTE_METHODS);
export const voteResultEnum = pgEnum("vote_result", VOTE_RESULTS);
export const voteSubjectEnum = pgEnum("vote_subject", VOTE_SUBJECTS);
export const decisionKindEnum = pgEnum("decision_kind", DECISION_KINDS);
export const decisionMethodEnum = pgEnum("decision_method", DECISION_METHODS);

/** A vote recorded by the Mesa: counts, majority and the computed result. */
export const votes = pgTable(
  "votes",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    subjectType: voteSubjectEnum("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    method: voteMethodEnum("method").notNull(),
    inFavor: integer("in_favor").notNull().default(0),
    against: integer("against").notNull().default(0),
    abstentions: integer("abstentions").notNull().default(0),
    blank: integer("blank").notNull().default(0),
    invalid: integer("invalid").notNull().default(0),
    /** Members present with vote, when the denominator needs it. */
    present: integer("present"),
    majority: majorityEnum("majority").notNull(),
    result: voteResultEnum("result").notNull(),
    note: text("note"),
    recordedByUserId: text("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_votes_assembly").on(table.assemblyId),
    index("idx_votes_subject").on(table.subjectType, table.subjectId),
  ],
);

/** Procedural decisions: admitting late amendments, unifying, agenda changes. */
export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    kind: decisionKindEnum("kind").notNull(),
    method: decisionMethodEnum("method").notNull(),
    voteId: text("vote_id").references(() => votes.id, {
      onDelete: "set null",
    }),
    subjectIds: jsonb("subject_ids").$type<string[]>().notNull().default([]),
    note: text("note"),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("idx_decisions_assembly").on(table.assemblyId)],
);

/**
 * Append-only history. Every state change of documents and amendments is
 * recorded here, which gives traceability and feeds live updates.
 */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorMemberId: text("actor_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_events_entity").on(table.entityType, table.entityId),
    index("idx_events_assembly_created").on(table.assemblyId, table.createdAt),
  ],
);

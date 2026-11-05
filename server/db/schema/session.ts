import {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cuid } from "./common";
import { users } from "./auth";
import { members } from "./member";
import { agendaItems } from "./agendaItem";
import { assemblies } from "./assembly";
import { impersonations } from "./impersonation";
import {
  DECISION_KINDS,
  DECISION_METHODS,
  VOTE_METHODS,
  VOTE_RESULTS,
  VOTE_SUBJECTS,
  SPEAKING_TURN_STATUSES,
} from "../../../shared/constants/domain";
import { majorityEnum } from "./document";

export const voteMethodEnum = pgEnum("vote_method", VOTE_METHODS);
export const voteResultEnum = pgEnum("vote_result", VOTE_RESULTS);
export const voteSubjectEnum = pgEnum("vote_subject", VOTE_SUBJECTS);
export const decisionKindEnum = pgEnum("decision_kind", DECISION_KINDS);
export const speakingTurnStatusEnum = pgEnum(
  "speaking_turn_status",
  SPEAKING_TURN_STATUSES,
);
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
 * recorded here, which gives traceability and feeds live updates. Write it
 * only through recordEvent (server/utils/domain/events.ts).
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
    /**
     * Set when an Admin did it while acting as the actor's account
     * (recordEvent takes it from the actor). The actor columns keep the
     * account acted as, so authorship and visibility stay its own.
     */
    impersonationId: text("impersonation_id").references(
      () => impersonations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_events_entity").on(table.entityType, table.entityId),
    index("idx_events_assembly_created").on(table.assemblyId, table.createdAt),
    // Activity lists page by (created_at, id) descending: a backward scan.
    index("idx_events_actor_created").on(
      table.actorUserId,
      table.createdAt,
      table.id,
    ),
    index("idx_events_member_created").on(
      table.actorMemberId,
      table.createdAt,
      table.id,
    ),
    index("idx_events_impersonation")
      .on(table.impersonationId)
      .where(sql`${table.impersonationId} is not null`),
    // The Admin log without filters pages the whole table by (created_at, id).
    index("idx_events_created").on(table.createdAt, table.id),
    // "Mi miembro" also reads given types by their payload, newest first.
    index("idx_events_type_created").on(table.type, table.createdAt),
  ],
);

/**
 * Requests to speak the Mesa writes down during the session, in order. A
 * turn belongs to a member (who speaks for it) and, optionally, to the
 * agenda item being debated; `speaker` is the person's name when known.
 */
export const speakingTurns = pgTable(
  "speaking_turns",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    agendaItemId: text("agenda_item_id").references(() => agendaItems.id, {
      onDelete: "set null",
    }),
    memberId: text("member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    speaker: text("speaker"),
    status: speakingTurnStatusEnum("status").notNull().default("waiting"),
    /** Queue position among waiting turns; lower speaks first. */
    position: integer("position").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
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
    index("idx_speaking_turns_assembly").on(table.assemblyId, table.status),
  ],
);

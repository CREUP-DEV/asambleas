import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { cuid } from "./common";
import { users } from "./auth";
import { assemblies } from "./assembly";
import { members } from "./member";
import {
  SEATING_GROUP_CATEGORIES,
  SEATING_GROUP_KINDS,
  SEATING_GROUP_SOURCES,
  SEATING_PERSON_SOURCES,
  SEATING_PERSON_STATUSES,
  SEATING_SYNC_STATUSES,
} from "../../../shared/constants/domain";
import type { SeatingLayout } from "../../../shared/utils/seating/layout";

export const seatingGroupKindEnum = pgEnum(
  "seating_group_kind",
  SEATING_GROUP_KINDS,
);
export const seatingGroupSourceEnum = pgEnum(
  "seating_group_source",
  SEATING_GROUP_SOURCES,
);
export const seatingGroupCategoryEnum = pgEnum(
  "seating_group_category",
  SEATING_GROUP_CATEGORIES,
);
export const seatingPersonSourceEnum = pgEnum(
  "seating_person_source",
  SEATING_PERSON_SOURCES,
);
export const seatingPersonStatusEnum = pgEnum(
  "seating_person_status",
  SEATING_PERSON_STATUSES,
);
export const seatingSyncStatusEnum = pgEnum(
  "seating_sync_status",
  SEATING_SYNC_STATUSES,
);

const at = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/**
 * The room of an assembly («Sala», docs/seating-plan.md): one per assembly,
 * made by the first write or sync (a read creates nothing).
 *
 * `layout` is a SeatingLayout (shared/utils/seating/layout.ts), validated by
 * seatingLayoutSchema on every write and stored with its `schemaVersion`;
 * `layoutUpdatedAt` is its lock token (PUT .../seating/layout), null while
 * there is no layout. `syncedAt` is the last time the Intranet was asked,
 * whatever it answered (`syncStatus`): the server-side throttle reads it.
 */
export const seatingPlans = pgTable(
  "seating_plans",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    assemblyId: text("assembly_id")
      .notNull()
      .references(() => assemblies.id, { onDelete: "cascade" }),
    layout: jsonb("layout").$type<SeatingLayout>(),
    layoutUpdatedAt: at("layout_updated_at"),
    layoutUpdatedByUserId: text("layout_updated_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    /** The Intranet event the last good sync read, for the header. */
    intranetEventId: integer("intranet_event_id"),
    intranetEventName: text("intranet_event_name"),
    /**
     * Another assembly whose Intranet attendees this plan reads (an AGE held
     * next to an AGO without an event of its own); null for its own.
     */
    sourceAssemblyId: text("source_assembly_id").references(
      () => assemblies.id,
      { onDelete: "set null" },
    ),
    syncedAt: at("synced_at"),
    syncStatus: seatingSyncStatusEnum("sync_status"),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("seating_plans_assembly_unique").on(table.assemblyId),
  ],
);

/**
 * What the tray lists and a block of seats belongs to: an Intranet account
 * that registered attendees, the Mesa (the platform's own, `kind` mesa), or
 * a group made by hand («Prensa»). The colour of its place cards comes from
 * `kind` and `intranetType` together (seatingGroupColour). `acronym` and
 * `name` are snapshots. `logoVersion` is the Intranet's and `logoFile` the
 * cached WebP (seating-images queue); `goneAt` is set when the Intranet stops
 * listing the account. `updatedAt` is the lock token of PATCH.
 */
export const seatingGroups = pgTable(
  "seating_groups",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    planId: text("plan_id")
      .notNull()
      .references(() => seatingPlans.id, { onDelete: "cascade" }),
    source: seatingGroupSourceEnum("source").notNull(),
    intranetAccountId: integer("intranet_account_id"),
    /** The platform member with that Intranet id (members.intranetId). */
    memberId: text("member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    kind: seatingGroupKindEnum("kind").notNull(),
    /** `users.type` as the Intranet sent it. */
    intranetType: text("intranet_type"),
    category: seatingGroupCategoryEnum("category"),
    acronym: text("acronym").notNull(),
    name: text("name").notNull(),
    logoVersion: text("logo_version"),
    logoFile: text("logo_file"),
    /** The Intranet's order of a CEA office (CeaSortingService). */
    order: integer("intranet_order"),
    goneAt: at("gone_at"),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("seating_groups_plan_account_unique")
      .on(table.planId, table.intranetAccountId)
      .where(sql`${table.intranetAccountId} is not null`),
    index("idx_seating_groups_plan").on(table.planId),
  ],
);

/**
 * One person who may take a seat: an Intranet registration, someone added
 * by hand, or a seat kept without a name («Plaza sin nombre», `placeholder`,
 * no names). Names and photos are personal data: only seating readers get
 * them, never an event, an audit row, a log or a notification. `position`
 * orders a group (the Intranet's at first, then by hand); `updatedAt` is the
 * lock token of PATCH.
 */
export const seatingPeople = pgTable(
  "seating_people",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    planId: text("plan_id")
      .notNull()
      .references(() => seatingPlans.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => seatingGroups.id, { onDelete: "cascade" }),
    source: seatingPersonSourceEnum("source").notNull(),
    intranetAttendeeId: integer("intranet_attendee_id"),
    firstName: text("first_name"),
    surname: text("surname"),
    /** A cargo such as «Presidencia de la Mesa». */
    label: text("label"),
    status: seatingPersonStatusEnum("status").notNull(),
    goneAt: at("gone_at"),
    /** False for «No necesita asiento»: out of every count. */
    needsSeat: boolean("needs_seat").notNull().default(true),
    /** A platform account, for the Mesa. */
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    photoVersion: text("photo_version"),
    photoFile: text("photo_file"),
    position: integer("position").notNull().default(0),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("seating_people_plan_attendee_unique")
      .on(table.planId, table.intranetAttendeeId)
      .where(sql`${table.intranetAttendeeId} is not null`),
    index("idx_seating_people_plan").on(table.planId),
    index("idx_seating_people_group").on(table.groupId),
  ],
);

/**
 * Who sits on each seat (a seat id of the plan's layout). A batch never
 * updates a row in place: it deletes every seat it touches and inserts the
 * new occupants, so a swap never meets the unique person index halfway.
 */
export const seatingAssignments = pgTable(
  "seating_assignments",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => seatingPlans.id, { onDelete: "cascade" }),
    seatId: text("seat_id").notNull(),
    personId: text("person_id")
      .notNull()
      .references(() => seatingPeople.id, { onDelete: "cascade" }),
    updatedAt: at("updated_at").defaultNow().notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.seatId] }),
    uniqueIndex("seating_assignments_plan_person_unique").on(
      table.planId,
      table.personId,
    ),
    index("idx_seating_assignments_person").on(table.personId),
  ],
);

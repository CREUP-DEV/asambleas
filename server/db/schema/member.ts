import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cuid } from "./common";
import { MEMBER_KINDS, MEMBER_SOURCES } from "../../../shared/constants/domain";

export const memberKindEnum = pgEnum("member_kind", MEMBER_KINDS);
export const memberSourceEnum = pgEnum("member_source", MEMBER_SOURCES);

/**
 * Members present documents and amendments: student councils (asociados),
 * sectorials and executive areas. Asociados and sectorials are synced from
 * the intranet roster, matched by their Intranet id first and then by
 * acronym (the intranet's "initials").
 */
export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    kind: memberKindEnum("kind").notNull().default("asociado"),
    acronym: text("acronym").notNull(),
    name: text("name").notNull(),
    university: text("university"),
    region: text("region"),
    /**
     * The Intranet account of an asociado or sectorial (its `users.id`), from
     * the roster: it survives a change of acronym. Null for manual members
     * and executive areas (a CEA account's id is a person, not an area).
     */
    intranetId: integer("intranet_id"),
    source: memberSourceEnum("source").notNull().default("manual"),
    active: boolean("active").notNull().default(true),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    uniqueIndex("members_acronym_unique").on(table.acronym),
    uniqueIndex("members_intranet_id_unique")
      .on(table.intranetId)
      .where(sql`${table.intranetId} is not null`),
    index("idx_members_kind").on(table.kind),
  ],
);

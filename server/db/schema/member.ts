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
     * The Intranet account of an asociado, a sectorial or a CEA office (its
     * `users.id`, a CEA account being the office's place), from the roster:
     * it survives a change of acronym. Null for manual members.
     */
    intranetId: integer("intranet_id"),
    /**
     * That account's sign-in email, lowercased, from the roster: it survives
     * the account being recreated with a new id, and links the platform
     * account that signs in with it. Never sent to a client, an audit row
     * nor a log.
     */
    email: text("email"),
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
    uniqueIndex("members_email_unique")
      .on(table.email)
      .where(sql`${table.email} is not null`),
    index("idx_members_kind").on(table.kind),
  ],
);

import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { roles } from "./rbac";
import { members } from "./member";
import type { AccessRevokedReason } from "../../../shared/constants/activity";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    roleId: text("role_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    externalRole: text("external_role"),
    externalName: text("external_name"),
    externalInitials: text("external_initials"),
    university: text("university"),
    /** The member this account acts for (an Asociado account is its member). */
    memberId: text("member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    lastRoleSyncAt: timestamp("last_role_sync_at", {
      withTimezone: true,
      mode: "date",
    }),
    /**
     * The account's id in the Intranet (its `users.id`), from the role
     * lookup. Not unique: it only helps to link the account to its member.
     */
    intranetId: integer("intranet_id"),
    /**
     * Set when the account lost access to the platform (the Intranet deleted
     * it): sign-in is refused until the Intranet knows it again. Set and
     * cleared together with `accessRevokedReason` (CHECK
     * users_access_revoked_consistent).
     */
    accessRevokedAt: timestamp("access_revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** Why the account lost access (ACCESS_REVOKED_REASONS); null while it has access. */
    accessRevokedReason: text(
      "access_revoked_reason",
    ).$type<AccessRevokedReason>(),
    /**
     * No longer read nor written: whether the welcome was seen is kept per
     * browser now. Kept one release, because better-auth reads every column
     * of the row: the previous release, and a rollback to it, still select
     * it. Drop it in a later migration.
     */
    onboardingSeenAt: timestamp("onboarding_seen_at", {
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
    check(
      "users_access_revoked_consistent",
      sql`(${table.accessRevokedAt} is null) = (${table.accessRevokedReason} is null)`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("idx_sessions_user_id").on(table.userId),
    index("idx_sessions_expires_at").on(table.expiresAt),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [
    index("idx_accounts_user_id").on(table.userId),
    // better-auth >= 1.7.3 identifies an account by (provider, account id)
    // again and rejects lookups that match more than one row.
    uniqueIndex("accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => sql`now()`),
  },
  (table) => [index("idx_verifications_expires_at").on(table.expiresAt)],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  role: one(roles, {
    fields: [users.roleId],
    references: [roles.id],
  }),
  member: one(members, {
    fields: [users.memberId],
    references: [members.id],
  }),
  sessions: many(sessions),
  accounts: many(accounts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

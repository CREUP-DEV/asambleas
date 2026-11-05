import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cuid } from "./common";
import { users } from "./auth";
import { impersonations } from "./impersonation";
import type { AuditSource } from "../../../shared/constants/activity";

/**
 * What happened outside the assembly history (events): accounts, roles,
 * permissions, members, sign-ins, exports and impersonation. Write it only
 * through recordAudit (server/utils/domain/audit.ts), which fills the actor,
 * the impersonation, the IP and the user agent; a test rejects direct
 * inserts elsewhere. `action` comes from AUDIT_ACTIONS.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    /** The effective user who did it (the account acted as, when impersonating); null for the system. */
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Set when an Admin did it while acting as `actorUserId`, and on the impersonation's own rows. */
    impersonationId: text("impersonation_id").references(
      () => impersonations.id,
      { onDelete: "set null" },
    ),
    /** Where it came from (AUDIT_SOURCES). */
    source: text("source").$type<AuditSource>().notNull().default("user"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    /** The assembly it concerns, when there is one. No foreign key: it survives deleting the assembly. */
    assemblyId: text("assembly_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    /** The request's client (getRequestIP with X-Forwarded-For). Personal data: see docs/design.md. */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Activity lists page by (created_at, id) descending: a backward scan.
    index("idx_audit_log_actor_created").on(
      table.actorUserId,
      table.createdAt,
      table.id,
    ),
    index("idx_audit_log_target_created").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
    index("idx_audit_log_action_created").on(table.action, table.createdAt),
    index("idx_audit_log_assembly")
      .on(table.assemblyId, table.createdAt)
      .where(sql`${table.assemblyId} is not null`),
    index("idx_audit_log_impersonation")
      .on(table.impersonationId)
      .where(sql`${table.impersonationId} is not null`),
    index("idx_audit_log_created_at").on(table.createdAt),
  ],
);

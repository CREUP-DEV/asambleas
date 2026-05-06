import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { cuid } from "./common";
import { users } from "./auth";

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(cuid),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_audit_log_actor").on(table.actorUserId),
    index("idx_audit_log_created_at").on(table.createdAt),
  ],
);

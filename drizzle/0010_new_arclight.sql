CREATE TABLE "impersonations" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_user_id" text,
	"target_user_id" text,
	"session_id" text NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
DROP INDEX "idx_audit_log_actor";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "impersonation_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "impersonation_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "assembly_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "ip_address" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonations" ADD CONSTRAINT "impersonations_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "impersonations_open_session" ON "impersonations" USING btree ("session_id") WHERE "impersonations"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "idx_impersonations_target_started" ON "impersonations" USING btree ("target_user_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_impersonations_admin_started" ON "impersonations" USING btree ("admin_user_id","started_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_impersonation_id_impersonations_id_fk" FOREIGN KEY ("impersonation_id") REFERENCES "public"."impersonations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_impersonation_id_impersonations_id_fk" FOREIGN KEY ("impersonation_id") REFERENCES "public"."impersonations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_actor_created" ON "events" USING btree ("actor_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_events_member_created" ON "events" USING btree ("actor_member_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_events_impersonation" ON "events" USING btree ("impersonation_id") WHERE "events"."impersonation_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_audit_log_actor_created" ON "audit_log" USING btree ("actor_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_target_created" ON "audit_log" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_action_created" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_assembly" ON "audit_log" USING btree ("assembly_id","created_at") WHERE "audit_log"."assembly_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_audit_log_impersonation" ON "audit_log" USING btree ("impersonation_id") WHERE "audit_log"."impersonation_id" is not null;
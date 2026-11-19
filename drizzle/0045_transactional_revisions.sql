CREATE TYPE "public"."transactional_revision_status" AS ENUM('pending_parties', 'pending_validation', 'applied', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "transactional_revision_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"member_id" text NOT NULL,
	"decision" "acceptance_decision" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"recorded_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "transactional_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"transactional_id" text NOT NULL,
	"proposed_by_user_id" text,
	"proposed_as_member_id" text,
	"staff_proposed" boolean DEFAULT false NOT NULL,
	"added_source_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"ops" jsonb NOT NULL,
	"justification" text DEFAULT '' NOT NULL,
	"status" "transactional_revision_status" DEFAULT 'pending_parties' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transactional_revision_acceptances" ADD CONSTRAINT "transactional_revision_acceptances_revision_id_transactional_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."transactional_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_revision_acceptances" ADD CONSTRAINT "transactional_revision_acceptances_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_revision_acceptances" ADD CONSTRAINT "transactional_revision_acceptances_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_revisions" ADD CONSTRAINT "transactional_revisions_transactional_id_amendments_id_fk" FOREIGN KEY ("transactional_id") REFERENCES "public"."amendments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_revisions" ADD CONSTRAINT "transactional_revisions_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactional_revisions" ADD CONSTRAINT "transactional_revisions_proposed_as_member_id_members_id_fk" FOREIGN KEY ("proposed_as_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transactional_revision_acceptances_party_unique" ON "transactional_revision_acceptances" USING btree ("revision_id","member_id");--> statement-breakpoint
CREATE INDEX "idx_transactional_revisions_transactional" ON "transactional_revisions" USING btree ("transactional_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactional_revisions_open_unique" ON "transactional_revisions" USING btree ("transactional_id") WHERE status in ('pending_parties', 'pending_validation');
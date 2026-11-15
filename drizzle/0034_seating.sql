CREATE TYPE "public"."seating_group_category" AS ENUM('individual', 'multiuser');--> statement-breakpoint
CREATE TYPE "public"."seating_group_kind" AS ENUM('mesa', 'cea', 'asociado', 'sectorial', 'other');--> statement-breakpoint
CREATE TYPE "public"."seating_group_source" AS ENUM('intranet', 'manual');--> statement-breakpoint
CREATE TYPE "public"."seating_person_source" AS ENUM('intranet', 'manual', 'placeholder');--> statement-breakpoint
CREATE TYPE "public"."seating_person_status" AS ENUM('confirmed', 'pending', 'manual');--> statement-breakpoint
CREATE TYPE "public"."seating_sync_status" AS ENUM('ok', 'not_found', 'unavailable', 'failed', 'unconfigured');--> statement-breakpoint
CREATE TABLE "seating_assignments" (
	"plan_id" text NOT NULL,
	"seat_id" text NOT NULL,
	"person_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "seating_assignments_plan_id_seat_id_pk" PRIMARY KEY("plan_id","seat_id")
);
--> statement-breakpoint
CREATE TABLE "seating_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"source" "seating_group_source" NOT NULL,
	"intranet_account_id" integer,
	"member_id" text,
	"kind" "seating_group_kind" NOT NULL,
	"intranet_type" text,
	"category" "seating_group_category",
	"acronym" text NOT NULL,
	"name" text NOT NULL,
	"logo_version" text,
	"logo_file" text,
	"intranet_order" integer,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seating_people" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"group_id" text NOT NULL,
	"source" "seating_person_source" NOT NULL,
	"intranet_attendee_id" integer,
	"first_name" text,
	"surname" text,
	"label" text,
	"status" "seating_person_status" NOT NULL,
	"gone_at" timestamp with time zone,
	"needs_seat" boolean DEFAULT true NOT NULL,
	"user_id" text,
	"photo_version" text,
	"photo_file" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seating_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"layout" jsonb,
	"layout_updated_at" timestamp with time zone,
	"layout_updated_by_user_id" text,
	"intranet_event_id" integer,
	"intranet_event_name" text,
	"source_assembly_id" text,
	"synced_at" timestamp with time zone,
	"sync_status" "seating_sync_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seating_assignments" ADD CONSTRAINT "seating_assignments_plan_id_seating_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."seating_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_assignments" ADD CONSTRAINT "seating_assignments_person_id_seating_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."seating_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_assignments" ADD CONSTRAINT "seating_assignments_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_groups" ADD CONSTRAINT "seating_groups_plan_id_seating_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."seating_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_groups" ADD CONSTRAINT "seating_groups_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_people" ADD CONSTRAINT "seating_people_plan_id_seating_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."seating_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_people" ADD CONSTRAINT "seating_people_group_id_seating_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."seating_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_people" ADD CONSTRAINT "seating_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_plans" ADD CONSTRAINT "seating_plans_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_plans" ADD CONSTRAINT "seating_plans_layout_updated_by_user_id_users_id_fk" FOREIGN KEY ("layout_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_plans" ADD CONSTRAINT "seating_plans_source_assembly_id_assemblies_id_fk" FOREIGN KEY ("source_assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seating_assignments_plan_person_unique" ON "seating_assignments" USING btree ("plan_id","person_id");--> statement-breakpoint
CREATE INDEX "idx_seating_assignments_person" ON "seating_assignments" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seating_groups_plan_account_unique" ON "seating_groups" USING btree ("plan_id","intranet_account_id") WHERE "seating_groups"."intranet_account_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_seating_groups_plan" ON "seating_groups" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seating_people_plan_attendee_unique" ON "seating_people" USING btree ("plan_id","intranet_attendee_id") WHERE "seating_people"."intranet_attendee_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_seating_people_plan" ON "seating_people" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_seating_people_group" ON "seating_people" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seating_plans_assembly_unique" ON "seating_plans" USING btree ("assembly_id");
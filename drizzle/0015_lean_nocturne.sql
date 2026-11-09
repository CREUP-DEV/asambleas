CREATE TYPE "public"."attendance_mark" AS ENUM('present', 'delegated');--> statement-breakpoint
CREATE TYPE "public"."quorum_call" AS ENUM('first', 'second');--> statement-breakpoint
CREATE TABLE "headcount_entries" (
	"headcount_id" text NOT NULL,
	"member_id" text NOT NULL,
	"mark" "attendance_mark" NOT NULL,
	"delegate_member_id" text,
	CONSTRAINT "headcount_entries_headcount_id_member_id_pk" PRIMARY KEY("headcount_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "headcounts" (
	"id" text PRIMARY KEY NOT NULL,
	"assembly_id" text NOT NULL,
	"call" "quorum_call" DEFAULT 'first' NOT NULL,
	"eligible" integer NOT NULL,
	"in_room" integer NOT NULL,
	"delegated" integer NOT NULL,
	"present" integer NOT NULL,
	"required" integer NOT NULL,
	"note" text,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assemblies" ALTER COLUMN "settings" SET DEFAULT '{"positionVisibility":"session","tieRule":"rejected","denominator":"present"}'::jsonb;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "headcount_id" text;--> statement-breakpoint
ALTER TABLE "headcount_entries" ADD CONSTRAINT "headcount_entries_headcount_id_headcounts_id_fk" FOREIGN KEY ("headcount_id") REFERENCES "public"."headcounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_entries" ADD CONSTRAINT "headcount_entries_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_entries" ADD CONSTRAINT "headcount_entries_delegate_member_id_members_id_fk" FOREIGN KEY ("delegate_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcounts" ADD CONSTRAINT "headcounts_assembly_id_assemblies_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."assemblies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcounts" ADD CONSTRAINT "headcounts_taken_by_user_id_users_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_headcounts_assembly" ON "headcounts" USING btree ("assembly_id","taken_at");--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_headcount_id_headcounts_id_fk" FOREIGN KEY ("headcount_id") REFERENCES "public"."headcounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Majorities on the members present became the default: assemblies not yet
-- closed follow it; closed ones keep the base their votes were counted on.
UPDATE "assemblies" SET "settings" = "settings" || '{"denominator":"present"}'::jsonb WHERE "status" <> 'closed';

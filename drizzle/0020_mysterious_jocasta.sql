ALTER TYPE "public"."member_kind" ADD VALUE 'guest';--> statement-breakpoint
ALTER TABLE "headcount_entries" ADD COLUMN "voting" boolean DEFAULT true NOT NULL;
ALTER TABLE "live_state" ADD COLUMN "recess_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "live_state" ADD COLUMN "recess_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "live_state" ADD COLUMN "speaking_limit_seconds" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "first_projected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "speaking_turns" ADD COLUMN "limit_seconds" integer;
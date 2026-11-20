ALTER TYPE "public"."decision_kind" ADD VALUE 'alternatives';--> statement-breakpoint
ALTER TABLE "assemblies" ALTER COLUMN "settings" SET DEFAULT '{"tieRule":"rejected","denominator":"present","transactionalProposers":"involved"}'::jsonb;--> statement-breakpoint
ALTER TABLE "live_state" ADD COLUMN "amendment_bloc_options" jsonb;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "winning_option" integer;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "tie_resolution" text;
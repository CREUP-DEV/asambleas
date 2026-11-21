ALTER TYPE "public"."decision_kind" ADD VALUE 'bloc';--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "bloc_amendment_ids" jsonb;
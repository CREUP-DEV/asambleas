ALTER TABLE "documents" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "correction_note" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "correction_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "amendments" ADD COLUMN "validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "amendments" ADD COLUMN "validated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "amendments" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "amendments" ADD COLUMN "correction_note" text;--> statement-breakpoint
ALTER TABLE "amendments" ADD COLUMN "correction_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "amendments" ADD CONSTRAINT "amendments_validated_by_user_id_users_id_fk" FOREIGN KEY ("validated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Amendments already admitted before Secretaría validation existed keep
-- their place: validated and visible since they were submitted.
UPDATE "amendments" SET "validated_at" = coalesce("submitted_at", "created_at"), "published_at" = coalesce("submitted_at", "created_at") WHERE "status" <> 'draft' AND "admission" = 'admitted';

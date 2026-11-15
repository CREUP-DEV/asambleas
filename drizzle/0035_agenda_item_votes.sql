ALTER TYPE "public"."vote_subject" ADD VALUE 'agenda_item';--> statement-breakpoint
ALTER TYPE "public"."vote_subject" ADD VALUE 'procedural_motion';--> statement-breakpoint
ALTER TABLE "agenda_items" ADD COLUMN "voted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "unanimous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "voided_by_user_id" text;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
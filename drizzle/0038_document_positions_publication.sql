ALTER TABLE "documents" ADD COLUMN "positions_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "positions_published_by_user_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "positions_debate_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_positions_published_by_user_id_users_id_fk" FOREIGN KEY ("positions_published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- What delegates could already read stays public: under the old assembly
-- setting, "session" made the answers public once the assembly was in
-- session or closed (now for good, as after a debate), and "public" made them
-- public at once (now as published by the Secretaría).
UPDATE "documents" AS "d" SET "positions_debate_started_at" = now()
FROM "assemblies" AS "a"
WHERE "a"."id" = "d"."assembly_id"
  AND "a"."status" IN ('in_session', 'closed')
  AND coalesce("a"."settings"->>'positionVisibility', 'session') = 'session'
  AND "d"."positions_debate_started_at" IS NULL;--> statement-breakpoint
UPDATE "documents" AS "d" SET "positions_published_at" = now()
FROM "assemblies" AS "a"
WHERE "a"."id" = "d"."assembly_id"
  AND "a"."settings"->>'positionVisibility' = 'public'
  AND "d"."positions_published_at" IS NULL;

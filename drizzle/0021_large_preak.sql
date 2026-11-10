CREATE TABLE "headcount_guests" (
	"id" text PRIMARY KEY NOT NULL,
	"headcount_id" text NOT NULL,
	"user_id" text,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "kind" SET DEFAULT 'asociado'::text;--> statement-breakpoint
DROP TYPE "public"."member_kind";--> statement-breakpoint
CREATE TYPE "public"."member_kind" AS ENUM('asociado', 'sectorial', 'executive', 'other');--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "kind" SET DEFAULT 'asociado'::"public"."member_kind";--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "kind" SET DATA TYPE "public"."member_kind" USING "kind"::"public"."member_kind";--> statement-breakpoint
ALTER TABLE "headcount_guests" ADD CONSTRAINT "headcount_guests_headcount_id_headcounts_id_fk" FOREIGN KEY ("headcount_id") REFERENCES "public"."headcounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_guests" ADD CONSTRAINT "headcount_guests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "headcount_guests_user_unique" ON "headcount_guests" USING btree ("headcount_id","user_id");--> statement-breakpoint
ALTER TABLE "headcounts" DROP COLUMN "call";--> statement-breakpoint
DROP TYPE "public"."quorum_call";--> statement-breakpoint
-- The default role is now Otro (read only); Invitado is a new role given by
-- hand, whose accounts the Mesa marks at the headcounts.
UPDATE "roles" SET "name" = 'Otro', "description" = 'Solo lectura de contenido publicado', "updated_at" = now() WHERE "name" = 'Invitado' AND "is_system" = true;--> statement-breakpoint
INSERT INTO "roles" ("id", "name", "description", "is_system") VALUES ('r' || substr(md5(random()::text || clock_timestamp()::text), 1, 23), 'Invitado', 'Solo lectura de contenido publicado; la Mesa anota su asistencia en los recuentos', true) ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
-- One quorum per type: the call a session opens in (the second, or the only one).
UPDATE "calendar_rules" SET "rules" = jsonb_set("rules", '{quorum}', COALESCE(NULLIF("rules"->'quorum'->'secondCall', 'null'::jsonb), "rules"->'quorum'->'firstCall')), "updated_at" = now() WHERE "rules"->'quorum' ? 'firstCall';

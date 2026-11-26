CREATE TABLE "notice_seen" (
	"user_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notice_seen" ADD CONSTRAINT "notice_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every existing account starts having seen what came before «Avisos»: the
-- news of the last 30 days read as earlier ones, not as 30 new notices.
INSERT INTO "notice_seen" ("user_id", "seen_at") SELECT "id", now() FROM "users";
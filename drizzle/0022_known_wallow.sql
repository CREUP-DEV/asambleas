ALTER TABLE "members" ADD COLUMN "email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "members_email_unique" ON "members" USING btree ("email") WHERE "members"."email" is not null;
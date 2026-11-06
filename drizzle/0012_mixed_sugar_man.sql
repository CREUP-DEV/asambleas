ALTER TABLE "users" ADD COLUMN "intranet_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_revoked_reason" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "intranet_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "members_intranet_id_unique" ON "members" USING btree ("intranet_id") WHERE "members"."intranet_id" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_access_revoked_consistent" CHECK (("users"."access_revoked_at" is null) = ("users"."access_revoked_reason" is null));
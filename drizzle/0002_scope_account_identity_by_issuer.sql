-- better-auth 1.7 scopes account identity by (issuer, account_id) instead of
-- (provider_id, account_id). "issuer" is required, so it is added nullable,
-- backfilled with the issuer Google declares, and only then promoted to
-- NOT NULL. Google is the sole provider; SET NOT NULL fails loudly if a row
-- from another provider ever shows up rather than corrupting it.
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_provider_id_account_id_unique";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "issuer" text;--> statement-breakpoint
UPDATE "accounts" SET "issuer" = 'https://accounts.google.com' WHERE "provider_id" = 'google';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_issuer_account_id_unique" ON "accounts" USING btree ("issuer","account_id");

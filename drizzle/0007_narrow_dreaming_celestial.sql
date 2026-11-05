ALTER TABLE "assemblies" ALTER COLUMN "settings" SET DEFAULT '{"positionVisibility":"session","acceptedAmendments":"assent","tieRule":"rejected","denominator":"valid_votes"}'::jsonb;--> statement-breakpoint
-- Amendment visibility is per amendment now (publishedAt); drop the old setting.
UPDATE "assemblies" SET "settings" = "settings" - 'amendmentVisibility';

ALTER TABLE "documents" ADD COLUMN "signed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The structured actas, budgets and reports already stored are
-- signed, as their kinds now default to (user's decision of 2026-11-28).
-- The acta de acuerdos (generated) keeps its own signing.
UPDATE "documents" SET "signed" = true WHERE "format" = 'structured' AND "generated" IS NULL AND "kind" IN ('minutes', 'budget', 'report');

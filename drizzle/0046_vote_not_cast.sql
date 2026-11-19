ALTER TABLE "votes" ADD COLUMN "not_cast" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- What was recorded as abstentions were the members present who cast
-- nothing (votos no emitidos); the blank ballots of a vote by show of
-- hands, roll call or the portal were its abstentions; blank and invalid
-- ballots stay only in secret votes (decision of 2026-11-19). An invalid
-- ballot outside a secret vote joins those who cast nothing. Results are
-- kept as recorded.
UPDATE "votes"
SET
	"not_cast" = "abstentions" + CASE WHEN "method" = 'secret' THEN 0 ELSE "invalid" END,
	"abstentions" = CASE WHEN "method" = 'secret' THEN 0 ELSE "blank" END,
	"blank" = CASE WHEN "method" = 'secret' THEN "blank" ELSE 0 END,
	"invalid" = CASE WHEN "method" = 'secret' THEN "invalid" ELSE 0 END;--> statement-breakpoint
-- The counts the history of a vote carries read the same as the vote now.
UPDATE "events"
SET "payload" = "events"."payload" || jsonb_build_object(
	'abstentions', "votes"."abstentions",
	'blank', "votes"."blank",
	'invalid', "votes"."invalid",
	'notCast', "votes"."not_cast"
)
FROM "votes"
WHERE "events"."type" IN ('document_voted', 'amendment_approved', 'amendment_rejected')
	AND "events"."payload" ? 'abstentions'
	AND "events"."payload"->>'voteId' = "votes"."id";

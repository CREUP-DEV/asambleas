-- Amendments presented by an executive area are coded "CEA n" for everyone,
-- numbered per document across all the areas (they were "<area acronym> n",
-- numbered per area). Renumbers the existing ones in the order they were
-- presented and rewrites the codes kept in event payloads, so the old codes,
-- which name the area, are gone: also the ones an amendment had before it
-- changed main author, and those of amendments deleted since.
-- A plain view rather than a temporary table, so the migration does not
-- depend on running inside one transaction. The amendments are updated last:
-- the view reads their old codes until then.
CREATE VIEW "executive_amendment_codes" AS
SELECT
	"presented"."id",
	"presented"."code" AS "old_code",
	(row_number() OVER (
		PARTITION BY "presented"."document_id"
		ORDER BY
			"presented"."number" ASC NULLS LAST,
			"presented"."submitted_at" ASC NULLS LAST,
			"presented"."created_at" ASC,
			"presented"."id" ASC
	))::integer AS "seq"
FROM (
	SELECT
		"amendments".*,
		-- The main author: the stored one, or the only author of the amendment.
		coalesce(
			"amendments"."meta"->>'presentingMemberId',
			(
				SELECT min("amendment_authors"."member_id")
				FROM "amendment_authors"
				WHERE "amendment_authors"."amendment_id" = "amendments"."id"
				HAVING count(*) = 1
			)
		) AS "main_author_id"
	FROM "amendments"
	WHERE "amendments"."kind" <> 'transactional'
		AND "amendments"."member_seq" IS NOT NULL
) AS "presented"
INNER JOIN "members" ON "members"."id" = "presented"."main_author_id"
WHERE "members"."kind" = 'executive';--> statement-breakpoint
-- The amendment's own code (amendment_submitted, amendment_deleted...). The
-- events of an amendment that name a transactional carry its "T n" code,
-- which never equals the old code and stays.
UPDATE "events"
SET "payload" = jsonb_set("events"."payload", '{code}', to_jsonb('CEA ' || "executive_amendment_codes"."seq"))
FROM "executive_amendment_codes"
WHERE "events"."entity_type" = 'amendment'
	AND "events"."entity_id" = "executive_amendment_codes"."id"
	AND "events"."payload"->>'code' = "executive_amendment_codes"."old_code";--> statement-breakpoint
-- The code of the amendment whose outcome closed a transactional.
UPDATE "events"
SET "payload" = jsonb_set("events"."payload", '{sourceCode}', to_jsonb('CEA ' || "executive_amendment_codes"."seq"))
FROM "executive_amendment_codes"
WHERE "events"."payload"->>'sourceId' = "executive_amendment_codes"."id"
	AND "events"."payload" ? 'sourceCode';--> statement-breakpoint
-- Older codes that name an area ("<area acronym> n") and are not the current
-- code of their amendment: one presented again under another main author
-- after a correction, or one deleted since. They take the new code of the
-- amendment when it has one; otherwise the code goes. Events that name a
-- transactional ("T n") are left alone.
UPDATE "events"
SET "payload" = jsonb_set(
	"events"."payload",
	'{code}',
	coalesce(
		(
			SELECT to_jsonb('CEA ' || "executive_amendment_codes"."seq")
			FROM "executive_amendment_codes"
			WHERE "executive_amendment_codes"."id" = "events"."entity_id"
		),
		'null'::jsonb
	)
)
WHERE "events"."entity_type" = 'amendment'
	AND NOT ("events"."payload" ? 'transactionalId')
	AND "events"."payload"->>'code' ~ ' [0-9]+$'
	AND EXISTS (
		SELECT 1
		FROM "members"
		WHERE "members"."kind" = 'executive'
			AND "members"."acronym" = regexp_replace("events"."payload"->>'code', ' [0-9]+$', '')
	);--> statement-breakpoint
-- The same for the code of an amendment that closed a transactional and has
-- no new code (the second statement gave the others theirs).
UPDATE "events"
SET "payload" = jsonb_set("events"."payload", '{sourceCode}', 'null'::jsonb)
WHERE "events"."payload"->>'sourceCode' ~ ' [0-9]+$'
	AND NOT EXISTS (
		SELECT 1
		FROM "executive_amendment_codes"
		WHERE "executive_amendment_codes"."id" = "events"."payload"->>'sourceId'
	)
	AND EXISTS (
		SELECT 1
		FROM "members"
		WHERE "members"."kind" = 'executive'
			AND "members"."acronym" = regexp_replace("events"."payload"->>'sourceCode', ' [0-9]+$', '')
	);--> statement-breakpoint
-- A draft sent back for correction that an area presented and whose main
-- author is no longer an area still holds the area's code: it gets a new one
-- when it is presented again (numberingToKeep), so the old one goes now.
UPDATE "amendments"
SET "code" = NULL, "member_seq" = NULL
WHERE "amendments"."kind" <> 'transactional'
	AND "amendments"."status" = 'draft'
	AND "amendments"."code" ~ ' [0-9]+$'
	AND NOT EXISTS (
		SELECT 1
		FROM "executive_amendment_codes"
		WHERE "executive_amendment_codes"."id" = "amendments"."id"
	)
	AND EXISTS (
		SELECT 1
		FROM "members"
		WHERE "members"."kind" = 'executive'
			AND "members"."acronym" = regexp_replace("amendments"."code", ' [0-9]+$', '')
	);--> statement-breakpoint
-- Deleted amendments of an area have no row left to renumber: their code goes.
UPDATE "events"
SET "payload" = jsonb_set("events"."payload", '{code}', 'null'::jsonb)
FROM "members"
WHERE "events"."type" = 'amendment_deleted'
	AND "events"."payload"->>'kind' <> 'transactional'
	AND "events"."payload"->>'code' IS NOT NULL
	AND "events"."payload"->>'mainAuthorId' = "members"."id"
	AND "members"."kind" = 'executive';--> statement-breakpoint
UPDATE "amendments"
SET
	"member_seq" = "executive_amendment_codes"."seq",
	"code" = 'CEA ' || "executive_amendment_codes"."seq"
FROM "executive_amendment_codes"
WHERE "amendments"."id" = "executive_amendment_codes"."id";--> statement-breakpoint
DROP VIEW "executive_amendment_codes";

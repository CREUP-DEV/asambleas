-- Amendments are numbered when they are presented, no longer on their first
-- publication, and their codes carry no space ("UGR1", "CEA2", "T1"). The
-- ones presented and not published before this rule have no number yet: they
-- take it now, in the order they were presented, after the highest number
-- and code each document already gave. Codes given before keep their form
-- ("CEUM 2") and stay taken.
WITH "presented" AS (
	SELECT
		"amendments"."id",
		"amendments"."document_id",
		"amendments"."submitted_at",
		"amendments"."created_at",
		CASE "members"."kind"
			WHEN 'executive' THEN 'CEA'
			WHEN 'asociado' THEN coalesce(nullif(btrim("members"."university_acronym"), ''), "members"."acronym")
			ELSE "members"."acronym"
		END AS "prefix"
	FROM "amendments"
	INNER JOIN "members" ON "members"."id" = coalesce(
		"amendments"."meta"->>'presentingMemberId',
		(
			SELECT min("amendment_authors"."member_id")
			FROM "amendment_authors"
			WHERE "amendment_authors"."amendment_id" = "amendments"."id"
			HAVING count(*) = 1
		)
	)
	WHERE "amendments"."kind" <> 'transactional'
		AND "amendments"."status" <> 'draft'
		AND "amendments"."code" IS NULL
),
"numbered" AS (
	SELECT
		"presented"."id",
		"presented"."prefix",
		(
			coalesce((
				SELECT max("given"."number")
				FROM "amendments" AS "given"
				WHERE "given"."document_id" = "presented"."document_id"
					AND "given"."kind" <> 'transactional'
			), 0)
			+ row_number() OVER (
				PARTITION BY "presented"."document_id"
				ORDER BY "presented"."submitted_at" ASC NULLS LAST, "presented"."created_at" ASC, "presented"."id" ASC
			)
		)::integer AS "number",
		(
			coalesce((
				SELECT max("given"."member_seq")
				FROM "amendments" AS "given"
				WHERE "given"."document_id" = "presented"."document_id"
					AND "given"."kind" <> 'transactional'
					AND "given"."code" IN (
						"presented"."prefix" || "given"."member_seq",
						"presented"."prefix" || ' ' || "given"."member_seq"
					)
			), 0)
			+ row_number() OVER (
				PARTITION BY "presented"."document_id", "presented"."prefix"
				ORDER BY "presented"."submitted_at" ASC NULLS LAST, "presented"."created_at" ASC, "presented"."id" ASC
			)
		)::integer AS "seq"
	FROM "presented"
)
UPDATE "amendments"
SET
	"number" = coalesce("amendments"."number", "numbered"."number"),
	"member_seq" = "numbered"."seq",
	"code" = "numbered"."prefix" || "numbered"."seq"
FROM "numbered"
WHERE "amendments"."id" = "numbered"."id";--> statement-breakpoint
-- Transactionals presented and not published yet: "T n" after the highest
-- one the document gave.
WITH "numbered" AS (
	SELECT
		"amendments"."id",
		(
			coalesce((
				SELECT max(substring("given"."code" FROM '^T ?([0-9]+)$')::integer)
				FROM "amendments" AS "given"
				WHERE "given"."document_id" = "amendments"."document_id"
					AND "given"."code" ~ '^T ?[0-9]+$'
			), 0)
			+ row_number() OVER (
				PARTITION BY "amendments"."document_id"
				ORDER BY "amendments"."submitted_at" ASC NULLS LAST, "amendments"."created_at" ASC, "amendments"."id" ASC
			)
		)::integer AS "seq"
	FROM "amendments"
	WHERE "amendments"."kind" = 'transactional'
		AND "amendments"."status" <> 'draft'
		AND "amendments"."code" IS NULL
)
UPDATE "amendments"
SET "code" = 'T' || "numbered"."seq"
FROM "numbered"
WHERE "amendments"."id" = "numbered"."id";

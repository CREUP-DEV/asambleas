ALTER TABLE "amendments" ADD COLUMN "first_projected_at" timestamp with time zone;--> statement-breakpoint
-- The amendments already put on screen, alone or in a bloc, from the
-- projection's history (live_changed carries amendmentId and amendmentBloc).
UPDATE "amendments" AS a
SET "first_projected_at" = p.at
FROM (
  SELECT shown.id, min(e.created_at) AS at
  FROM "events" AS e
  CROSS JOIN LATERAL (
    SELECT e.payload ->> 'amendmentId' AS id
    WHERE jsonb_typeof(e.payload -> 'amendmentId') = 'string'
    UNION
    SELECT jsonb_array_elements_text(e.payload -> 'amendmentBloc')
    WHERE jsonb_typeof(e.payload -> 'amendmentBloc') = 'array'
  ) AS shown
  WHERE e.type = 'live_changed'
  GROUP BY shown.id
) AS p
WHERE a.id = p.id AND a.first_projected_at IS NULL;

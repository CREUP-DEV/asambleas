ALTER TABLE "speaking_turns" ADD COLUMN "amendment_id" text;--> statement-breakpoint
ALTER TABLE "speaking_turns" ADD COLUMN "noted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "speaking_turns" ADD CONSTRAINT "speaking_turns_amendment_id_amendments_id_fk" FOREIGN KEY ("amendment_id") REFERENCES "public"."amendments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Turns already given: stamp each one with what was in debate when it took
-- the floor, read from the last live_changed event before it that carries
-- the pointer (some, like a recess, carry no ids). An item or an amendment
-- gone since keeps the turn's own item and no amendment.
UPDATE "speaking_turns" AS "t"
SET
  "agenda_item_id" = COALESCE("ai"."id", "t"."agenda_item_id"),
  "amendment_id" = "am"."id"
FROM (
  SELECT "t2"."id" AS "turn_id", "ev"."payload"
  FROM "speaking_turns" AS "t2"
  CROSS JOIN LATERAL (
    SELECT "e"."payload"
    FROM "events" AS "e"
    WHERE "e"."assembly_id" = "t2"."assembly_id"
      AND "e"."type" = 'live_changed'
      AND "e"."payload" ? 'agendaItemId'
      AND "e"."created_at" <= "t2"."started_at"
    ORDER BY "e"."created_at" DESC, "e"."id" DESC
    LIMIT 1
  ) AS "ev"
  WHERE "t2"."started_at" IS NOT NULL
) AS "s"
LEFT JOIN "agenda_items" AS "ai" ON "ai"."id" = "s"."payload" ->> 'agendaItemId'
LEFT JOIN "amendments" AS "am" ON "am"."id" = "s"."payload" ->> 'amendmentId'
WHERE "t"."id" = "s"."turn_id";

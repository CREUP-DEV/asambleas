import { sql } from "drizzle-orm";
import { db } from "../../db";
import { documentViews } from "../../db/schema";
import type {
  DocumentReadingBody,
  DocumentReadingDto,
} from "~~/shared/types/api";
import {
  READING_BEAT_MAX_SECONDS,
  READING_SLACK_SECONDS,
} from "~~/shared/utils/documentViews";
import type { DocumentRouteContext } from "./documents";

/** The day a view counts on: the association's, not the server's. */
const TODAY = sql`(now() at time zone 'Europe/Madrid')::date`;

/**
 * A beat of an open published document (docs/design.md, "Statistics"):
 * one more view when the page just opened it, and the seconds it was on
 * show with someone at it. The seconds are credited in SQL, so two tabs or
 * two racing beats never count the same time twice: never more than
 * READING_BEAT_MAX_SECONDS, nor than the time since the account's last beat
 * on the document that day (plus READING_SLACK_SECONDS).
 *
 * Nothing is kept for a document that is not published, nor while an
 * Admin acts as the account (its reading is not the account's). The row is
 * the record: no event nor audit row (each beat would fill the history).
 */
export async function recordDocumentReading(
  ctx: DocumentRouteContext,
  body: DocumentReadingBody,
): Promise<DocumentReadingDto> {
  const { actor, document } = ctx;
  if (document.status !== "published" || actor.impersonation) {
    return { recorded: false };
  }
  const views = body.opened ? 1 : 0;
  const seconds = Math.min(
    Math.max(0, Math.floor(body.seconds)),
    READING_BEAT_MAX_SECONDS,
  );
  if (views === 0 && seconds === 0) return { recorded: false };

  await db
    .insert(documentViews)
    .values({
      userId: actor.user.id,
      documentId: document.id,
      day: TODAY,
      views,
      seconds,
    })
    .onConflictDoUpdate({
      target: [
        documentViews.userId,
        documentViews.documentId,
        documentViews.day,
      ],
      set: {
        views: sql`${documentViews.views} + excluded.views`,
        seconds: sql`${documentViews.seconds} + least(excluded.seconds, greatest(0, floor(extract(epoch from (now() - ${documentViews.lastViewedAt})))::int + ${READING_SLACK_SECONDS}))`,
        lastViewedAt: sql`now()`,
      },
    });
  return { recorded: true };
}

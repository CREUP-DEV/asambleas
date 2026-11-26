import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { noticeSeen } from "../../db/schema";
import type { MeNoticesDto } from "~~/shared/types/api";
import { countNewNotices, dedupeNews } from "~~/shared/utils/notices";
import type { Actor } from "./actor";
import { assemblySettings } from "./documents";
import { loadWorkNews } from "./news";
import { assemblyRef, loadWorkAssemblies } from "./review";

/**
 * GET /api/me/notices («Avisos»): the news of the actor's member, and the
 * Mesa's for an account that moderates, over the assemblies the home page
 * covers (loadWorkNews, without the rows one decision produced twice), the
 * account's mark of how far it has seen them and how many are new against
 * it, counted on those same rows, and where a new notice may come from
 * (watchDocumentIds and, for the Mesa, watchAssemblyIds, read by
 * loadWorkNews with the same queries). Ids only, to the account itself:
 * the client reads the notices again on a live event about one of those
 * documents, or any in one of those assemblies, never on the rest of the
 * room's.
 */
export async function loadNotices(
  actor: Actor,
  now: Date = new Date(),
): Promise<MeNoticesDto> {
  const assemblyRows = await loadWorkAssemblies(actor);
  const [{ news, watchDocumentIds, watchAssemblyIds }, seenAt] =
    await Promise.all([
      loadWorkNews(
        actor,
        assemblyRows.map((row) => ({
          ref: assemblyRef(row),
          settings: assemblySettings(row),
          status: row.status,
        })),
        now,
      ),
      loadSeenAt(actor.user.id),
    ]);
  const items = dedupeNews(news);
  const seen = seenAt?.toISOString() ?? null;
  return {
    items,
    seenAt: seen,
    unread: countNewNotices(items, seen),
    watchDocumentIds,
    watchAssemblyIds,
  };
}

async function loadSeenAt(userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ seenAt: noticeSeen.seenAt })
    .from(noticeSeen)
    .where(eq(noticeSeen.userId, userId))
    .limit(1);
  return row?.seenAt ?? null;
}

/**
 * PUT /api/me/notices/seen: the account has seen its notices up to `at`
 * (the newest one its panel showed). The mark never goes back and never
 * past the present: `greatest(stored, least(at, now()))`. Nothing is
 * written while an Admin acts as the account, which did not see them.
 * Returns whether it wrote.
 */
export async function markNoticesSeen(
  actor: Actor,
  at: Date,
): Promise<boolean> {
  if (actor.impersonation) return false;
  await db
    .insert(noticeSeen)
    .values({
      userId: actor.user.id,
      seenAt: sql`least(${at.toISOString()}::timestamptz, now())`,
    })
    .onConflictDoUpdate({
      target: noticeSeen.userId,
      set: { seenAt: sql`greatest(${noticeSeen.seenAt}, excluded.seen_at)` },
    });
  return true;
}

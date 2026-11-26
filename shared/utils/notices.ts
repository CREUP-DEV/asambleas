/**
 * The notices («Avisos», GET /api/me/notices) as the server counts them and
 * the client lists them: the same rows on both sides, so the number in the
 * sidebar never counts a row the panel does not show.
 */
import type { MeWorkNewsDto } from "../types/api";

function time(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The news without the ones a single decision produced twice. Events
 * recorded together share their time, so two news about the same amendment
 * at the same instant come from one decision, and one sentence says it:
 * - a main author's rejection closes the transactional (it is withdrawn):
 *   the rejection says so, the withdrawal is dropped;
 * - the main presenter's acceptance incorporates the amendment: the
 *   incorporation names who accepted it, the answer is dropped;
 * - a new answer takes an incorporated amendment out again (it is
 *   reopened): the answer says so, the reopening is dropped.
 */
export function dedupeNews(list: MeWorkNewsDto[]): MeWorkNewsDto[] {
  const keyOf = (news: MeWorkNewsDto) =>
    news.amendment ? `${news.amendment.id}@${time(news.at) ?? news.at}` : null;
  const together = new Map<string, Set<string>>();
  for (const news of list) {
    const key = keyOf(news);
    if (!key) continue;
    const kinds = together.get(key) ?? new Set<string>();
    kinds.add(news.type);
    kinds.add(`${news.type}:${news.value ?? ""}`);
    together.set(key, kinds);
  }
  return list.filter((news) => {
    const key = keyOf(news);
    const kinds = key ? together.get(key) : undefined;
    if (!kinds) return true;
    switch (news.type) {
      case "amendment_withdrawn":
        return !kinds.has("acceptance_recorded:rejected");
      case "position_changed":
        return !(
          news.value === "accept" && kinds.has("amendment_approved:proponent")
        );
      case "amendment_reopened":
        return !kinds.has("position_changed");
      default:
        return true;
    }
  });
}

/**
 * Whether a notice is new: later than the account's mark (`seenAt`). With
 * no mark yet every notice is new; a moment that does not parse never is.
 */
export function isNewNotice(at: string, seenAt: string | null): boolean {
  const atMs = time(at);
  if (atMs === null) return false;
  const seenMs = seenAt === null ? null : time(seenAt);
  return seenMs === null || atMs > seenMs;
}

/** What the notices' rules read of a row: when it happened and reached the reader. */
export interface NoticeMoments {
  at: string;
  /** MeWorkNewsDto.visibleAt: when it reached the reader, if later. */
  visibleAt?: string;
}

/**
 * The moment a notice counts from: when it reached the reader
 * (`visibleAt`, an answer the reader could only read once the document's
 * answers were public), else when it happened (`at`). Whether it is new,
 * the panel's split and the mark all go by it; `at` stays the one shown.
 */
export function noticeMoment(item: NoticeMoments): string {
  return item.visibleAt ?? item.at;
}

/** How many of `items` are new against `seenAt` (isNewNotice). */
export function countNewNotices(
  items: readonly NoticeMoments[],
  seenAt: string | null,
): number {
  return items.filter((item) => isNewNotice(noticeMoment(item), seenAt)).length;
}

/**
 * The newest moment among `items` (noticeMoment), which opening the panel
 * marks as seen (PUT /api/me/notices/seen): never the client's clock, so a
 * notice that arrived after the list was read stays new. Null for an empty
 * list.
 */
export function newestNoticeAt(items: readonly NoticeMoments[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const moment = noticeMoment(item);
    const ms = time(moment);
    if (ms !== null && ms > bestMs) {
      best = moment;
      bestMs = ms;
    }
  }
  return best;
}

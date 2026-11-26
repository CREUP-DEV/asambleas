/**
 * Pure part of the notices («Avisos», useNotices and ShellNotices): when
 * the list is read again, which live events concern it, what the panel
 * shows as new and when the count is announced. No Vue or Nuxt here.
 *
 * The "-" prefix keeps Nuxt from registering this module (and its test) as
 * a composable; import it explicitly.
 */
import type { LiveEventDto, MeNoticesDto } from "~~/shared/types/api";
import {
  countNewNotices,
  isNewNotice,
  noticeMoment,
  type NoticeMoments,
} from "~~/shared/utils/notices";

/**
 * At most one read of the notices every 30 s, like ShellSessionBanner: the
 * list costs several queries (loadWorkNews), and a room full of open pages
 * must never read it on every live event.
 */
export const NOTICES_REFRESH_MS = 30_000;

/**
 * The document a live event is about: its `documentId`, or the event's own
 * entity for a document event, which may not carry it. Null when the event
 * names none.
 */
export function liveEventDocumentId(event: LiveEventDto): string | null {
  if (event.documentId) return event.documentId;
  return event.entityType === "document" ? event.entityId : null;
}

/** Where the account's notices may come from (MeNoticesDto). */
export interface NoticeWatch {
  /** MeNoticesDto.watchDocumentIds. */
  documentIds: readonly string[];
  /** MeNoticesDto.watchAssemblyIds: the Mesa's, where any event counts. */
  assemblyIds: readonly string[];
}

/**
 * Whether a batch of the hub's live events (of the assembly `assemblyId`)
 * may bring the account a new notice: a `poll` (the stream missed
 * changes), or a document or amendment event about one of the documents its
 * notices come from (MeNoticesDto.watchDocumentIds), or about any document
 * of an assembly the Mesa's notices cover (watchAssemblyIds). An amendment
 * event that names no document counts, since it cannot be ruled out. With
 * nothing watched, nothing counts.
 */
export function liveEventsTouchNotices(
  events: readonly LiveEventDto[],
  watch: NoticeWatch,
  assemblyId: string | null = null,
): boolean {
  const everything =
    assemblyId !== null && watch.assemblyIds.includes(assemblyId);
  // Nothing watched: no notice can come (the account has no member and does
  // not moderate, or it presents and wrote nothing in these assemblies).
  if (events.length === 0 || (!everything && watch.documentIds.length === 0)) {
    return false;
  }
  const watched = new Set(watch.documentIds);
  return events.some((event) => {
    if (event.type === "poll") return true;
    if (event.entityType !== "document" && event.entityType !== "amendment") {
      return false;
    }
    if (everything) return true;
    const documentId = liveEventDocumentId(event);
    return documentId === null ? true : watched.has(documentId);
  });
}

export interface NoticeRefresherOptions {
  /** Reads the notices; rejections are the caller's to swallow. */
  run: () => Promise<unknown>;
  /** Whether a list was read already: without one, any request reads. */
  hasData: () => boolean;
  /** Where the notices of the last list read come from (NoticeWatch). */
  watch: () => NoticeWatch;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  intervalMs?: number;
}

export interface NoticeRefresher {
  /**
   * A route change, the tab shown again or the panel opened: reads now,
   * unless a read started less than the interval ago (then nothing: the
   * next request will). Resolves when the read it started or joined ends,
   * at once when none.
   */
  request: () => Promise<void>;
  /**
   * A batch of the hub's live events, of the assembly `assemblyId`:
   * nothing unless it concerns the notices (liveEventsTouchNotices); then
   * reads now, or once at the end of the interval, so the change is never
   * lost.
   */
  live: (events: readonly LiveEventDto[], assemblyId?: string | null) => void;
  /** Reads now, whatever the interval. */
  force: () => Promise<void>;
  /** Drops a read waiting for the end of the interval. */
  dispose: () => void;
}

/**
 * The one schedule of the notices' reads: at most one every `intervalMs`,
 * one at a time, with no timer but the one that ends an interval a live
 * event fell in.
 */
export function createNoticeRefresher(
  options: NoticeRefresherOptions,
): NoticeRefresher {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const interval = options.intervalMs ?? NOTICES_REFRESH_MS;
  let lastAt: number | null = null;
  let inFlight: Promise<void> | null = null;
  let trailing: unknown = null;

  function start(): Promise<void> {
    if (inFlight) return inFlight;
    if (trailing !== null) {
      clearTimer(trailing);
      trailing = null;
    }
    lastAt = now();
    inFlight = options
      .run()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** Milliseconds until a read may start; 0 when it may now. */
  function wait(): number {
    if (!options.hasData() || lastAt === null) return 0;
    return Math.max(0, lastAt + interval - now());
  }

  return {
    request() {
      if (inFlight) return inFlight;
      return wait() === 0 ? start() : Promise.resolve();
    },
    live(events, assemblyId = null) {
      if (!liveEventsTouchNotices(events, options.watch(), assemblyId)) return;
      const ms = wait();
      if (ms === 0) {
        void start();
        return;
      }
      if (trailing !== null) return;
      trailing = setTimer(() => {
        trailing = null;
        void start();
      }, ms);
    },
    force: start,
    dispose() {
      if (trailing !== null) clearTimer(trailing);
      trailing = null;
    },
  };
}

/**
 * A list just read, against the mark this tab wrote or is writing
 * (`mark`, PUT /api/me/notices/seen): the server's mark only moves
 * forward, so a read that left before that write landed, and answers with
 * an older mark, keeps the later one and counts the new notices against
 * it. A notice newer than `mark` in that list still counts. Unchanged when
 * the list's own mark is as late or later, or there is no `mark`.
 */
export function withNoticeMark(
  fresh: MeNoticesDto,
  mark: string | null,
): MeNoticesDto {
  if (mark === null || !isNewNotice(mark, fresh.seenAt)) return fresh;
  return {
    ...fresh,
    seenAt: mark,
    unread: countNewNotices(fresh.items, mark),
  };
}

/** The later of two marks (isNewNotice); null when neither is set. */
export function laterNoticeMark(
  a: string | null,
  b: string | null,
): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return isNewNotice(b, a) ? b : a;
}

/**
 * The count to announce when it changed from `previous` to `next`: only a
 * rise with the page open, never the first read (`previous` null), a mark
 * of seen or another tab lowering it. Null when nothing is said.
 */
export function noticesAnnouncement(
  previous: number | null,
  next: number | null,
): number | null {
  if (previous === null || next === null) return null;
  return next > previous ? next : null;
}

/**
 * The panel's two lists: «Nuevos», the notices later than the mark the
 * account had when the panel opened (so opening it, which moves the mark,
 * does not empty the list being read), and «Anteriores», the rest. A
 * notice counts from when it reached the reader (noticeMoment). Both keep
 * the order given.
 */
export function splitNotices<T extends NoticeMoments>(
  items: readonly T[],
  seenAt: string | null,
): { fresh: T[]; earlier: T[] } {
  const fresh: T[] = [];
  const earlier: T[] = [];
  for (const item of items) {
    (isNewNotice(noticeMoment(item), seenAt) ? fresh : earlier).push(item);
  }
  return { fresh, earlier };
}

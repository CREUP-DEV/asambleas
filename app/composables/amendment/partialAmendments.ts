import type {
  DocumentAmendmentsDto,
  LiveEventDto,
  PartialDocumentAmendmentsDto,
} from "~~/shared/types/api";
import { PARTIAL_AMENDMENTS_MAX } from "~~/shared/utils/partialAmendments";
import { amendmentsRefetchPlan } from "../assembly/-liveFilters";

/**
 * Following a live event with only the amendments it changed
 * (GET .../amendments?ids=, PartialDocumentAmendmentsDto) instead of the
 * whole list of the document, which weighs 160-600 KB and which every
 * phone in the room would download on each vote. For the room only: the
 * document page, Directo and the projection. The Mesa's console, the
 * control sheet and the validation inbox act on the list and read it whole.
 */

/**
 * The list with a partial read merged in, or null when only the whole list
 * can say what it is now:
 * - another base text (another document, or the list of another version);
 * - an amendment the list did not have (it appeared for this reader: its
 *   relations and wordings are not in the partial read);
 * - an asked one it does not get (`gone`): who sees what changed, and with
 *   it what the others name (their links, the relations, the wordings), or
 *   it is hidden and what reads it (a transactional over it) may not be
 *   sent;
 * - one whose place in text order moved (`positionKey`, `number`).
 * Each amendment is replaced where it stands, so the list keeps the order
 * the server gives the whole list (text order), which Directo and the
 * projection read as it comes; the relations and wordings stay.
 */
export function mergePartialAmendments(
  current: DocumentAmendmentsDto,
  partial: PartialDocumentAmendmentsDto,
): DocumentAmendmentsDto | null {
  if (partial.baseVersionId !== current.baseVersionId) return null;
  if (partial.gone.length > 0) return null;
  const index = new Map(
    current.amendments.map((amendment, position) => [amendment.id, position]),
  );
  const amendments = [...current.amendments];
  for (const amendment of partial.amendments) {
    const position = index.get(amendment.id);
    if (position === undefined) return null;
    const before = amendments[position]!;
    if (
      before.positionKey !== amendment.positionKey ||
      before.number !== amendment.number
    ) {
      return null;
    }
    amendments[position] = amendment;
  }
  return { ...current, amendments };
}

export interface PartialAmendmentsRefetchOptions {
  /** The document whose list this is (its id, as live events carry it). */
  documentId: () => string | null | undefined;
  /**
   * The list on screen, or null when there is none or it is not up to date
   * (never loaded, its last read failed, another document's): the whole
   * list is read then.
   */
  current: () => DocumentAmendmentsDto | null | undefined;
  /** Puts a merged list in place (the fetch's data). */
  write: (dto: DocumentAmendmentsDto) => void;
  /**
   * Reads the whole list again, replacing any read of it in flight
   * (`refresh({ dedupe: "cancel" })`).
   */
  refreshAll: () => Promise<unknown>;
  /** Reads these amendments (GET .../amendments?ids=, same query else). */
  readSome: (ids: string[]) => Promise<PartialDocumentAmendmentsDto>;
  /** A read of the whole list is on its way (the fetch is pending). */
  readingAll: () => boolean;
}

export interface PartialAmendmentsRefetch {
  /** Follows a live batch: nothing, the whole list, or some amendments. */
  handle: (events: readonly LiveEventDto[]) => Promise<unknown> | null;
  /**
   * Call when a read of the whole list starts, from wherever (a sync
   * watcher on the fetch's status): a partial read in flight then gives
   * way to it. The ones this module starts count on their own.
   */
  readAllStarted: () => void;
  /**
   * Call after writing a mutation's answer into the list: a partial read
   * that left before it may bring back what it replaced, so it is read
   * again instead of applied.
   */
  wrote: () => void;
  /**
   * A partial read is on its way or waiting: the list may be about to
   * change, so it is not handed to another page (documentHandover).
   */
  busy: () => boolean;
}

/**
 * Follows the live batches of one document's amendments list, reading only
 * the amendments they changed when amendmentsRefetchPlan allows it, and the
 * whole list otherwise (also when a partial read fails, cannot be merged,
 * or the list is not up to date).
 *
 * Partial reads go one at a time: the ids of the batches that arrive
 * meanwhile wait and go in the next one (over PARTIAL_AMENDMENTS_MAX
 * together, the whole list instead). A partial read never lands over
 * something newer (CON-10): none leaves while a read of the whole list is on
 * its way (that read brings its ids), a read of the whole list that started
 * after it replaces it (its answer is dropped), and a mutation's answer
 * written after it started makes it read those ids again.
 */
export function partialAmendmentsRefetch(
  options: PartialAmendmentsRefetchOptions,
): PartialAmendmentsRefetch {
  /** Bumped by every read of the whole list that starts. */
  let readsAll = 0;
  /** Bumped by every mutation's answer written into the list. */
  let writes = 0;
  const waiting = new Set<string>();
  let running: Promise<void> | null = null;

  function readAll(): Promise<unknown> {
    waiting.clear();
    // Counted here too: one that replaces a read already on its way leaves
    // the fetch pending, so the status watcher never sees it start.
    readsAll += 1;
    return options.refreshAll();
  }

  async function drain(): Promise<void> {
    while (waiting.size > 0) {
      // A read of the whole list on its way started after these ids were
      // queued (handle replaces one on its way instead of queuing): it
      // brings them, and a partial read leaving now could land after it.
      if (options.readingAll()) {
        waiting.clear();
        return;
      }
      const ids = [...waiting];
      waiting.clear();
      const document = options.documentId();
      const startedReads = readsAll;
      const startedWrites = writes;
      let answer: PartialDocumentAmendmentsDto;
      try {
        answer = await options.readSome(ids);
      } catch {
        await readAll();
        continue;
      }
      // Another document now: its own read of the whole list follows it.
      // A read of the whole list that left after this one brings all of it.
      if (
        options.documentId() !== document ||
        readsAll !== startedReads ||
        options.readingAll()
      ) {
        continue;
      }
      if (writes !== startedWrites) {
        for (const id of ids) waiting.add(id);
        if (waiting.size > PARTIAL_AMENDMENTS_MAX) await readAll();
        continue;
      }
      const current = options.current();
      const merged = current ? mergePartialAmendments(current, answer) : null;
      if (merged) options.write(merged);
      else await readAll();
    }
  }

  function readSome(ids: string[]): Promise<unknown> {
    for (const id of ids) waiting.add(id);
    if (waiting.size > PARTIAL_AMENDMENTS_MAX) return readAll();
    if (!running) {
      running = drain().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return {
    handle(events) {
      const plan = amendmentsRefetchPlan(
        events,
        options.documentId(),
        PARTIAL_AMENDMENTS_MAX,
      );
      if (!plan) return null;
      // A read of the whole list on its way may have left before this
      // batch: it is replaced, never merged into (it would land after).
      if (plan.full || !options.current() || options.readingAll()) {
        return readAll();
      }
      return readSome(plan.ids);
    },
    readAllStarted() {
      readsAll += 1;
    },
    wrote() {
      writes += 1;
    },
    busy() {
      return running !== null || waiting.size > 0;
    },
  };
}

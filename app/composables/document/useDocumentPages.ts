import type { MaybeRefOrGetter } from "vue";
import type {
  DocumentDto,
  DocumentPagesDto,
  PageMapDto,
  VersionDto,
} from "~~/shared/types/api";
import { isPublicDocumentStatus } from "~~/shared/utils/agendaSubmissions";
import type { ContentPages } from "~/components/content/ContentView.vue";

/**
 * The pages of a document's PDFs, for its readers' «pág. N» (user's
 * decisions of 2026-11-21; GET …/documents/{document}/pages). Read on the
 * client once the text shows, and again when `key` changes (a new version,
 * a vote, a title). While the server is still computing them (`pending`)
 * it asks again, further apart each time and a little apart from the other
 * readers (pagesAskDelay), and stops at the first answer that is not
 * pending. It never asks while the tab is hidden: an ask due then waits
 * until the tab shows. A failure leaves no numbers: the text reads the
 * same without them.
 */

/** What to read: the assembly and the document (slugs or ids). */
export interface DocumentPagesTarget {
  assembly: string;
  document: string;
  /** Anything that changes the texts' PDFs; a change reads them again. */
  key: string;
}

const RETRY_MS = 20_000;
const MAX_RETRY_MS = 60_000;
/**
 * How long a reader keeps asking. The job may wait past the package's
 * prebuild (about 3 minutes in a convened or sitting assembly), then for the
 * render slot behind a whole package build; past the server's 10 minutes
 * (REQUEUE_AFTER_MS) an ask queues a failed job again.
 */
const RETRY_WINDOW_MS = 15 * 60_000;

/** The schedule's wait after `tries` pending answers: 20 s, 40 s, then 60 s. */
function retryStep(tries: number): number {
  return Math.min(RETRY_MS * (tries + 1), MAX_RETRY_MS);
}

/**
 * The wait before the next ask after `tries` asks that answered `pending`:
 * 20 s, 40 s, then a minute each time, or null once the next ask would fall
 * past RETRY_WINDOW_MS from the first.
 */
export function pagesRetryDelay(tries: number): number | null {
  let waited = 0;
  for (let index = 0; ; index += 1) {
    const delay = retryStep(index);
    if (waited + delay > RETRY_WINDOW_MS) return null;
    if (index >= tries) return delay;
    waited += delay;
  }
}

/** How far past its wait an ask may fall, so the readers do not ask at once. */
const JITTER = 0.25;

/**
 * The wait before the next ask after `tries` pending answers, `waited` ms
 * after the first ask: pagesRetryDelay's, or, when the server gives a
 * sensible `retryAfter` (seconds), that wait but never shorter than the
 * schedule's for this ask; plus up to a quarter more by `random` (0 to 1).
 * Null once the next ask would fall past RETRY_WINDOW_MS from the first:
 * only the window stops the asking, and a server that keeps saying «later»
 * never stretches it.
 */
export function pagesAskDelay(options: {
  tries: number;
  waited: number;
  retryAfter?: unknown;
  random: number;
}): number | null {
  const server =
    typeof options.retryAfter === "number" &&
    Number.isFinite(options.retryAfter) &&
    options.retryAfter > 0
      ? options.retryAfter * 1000
      : null;
  let base: number;
  if (server === null) {
    const scheduled = pagesRetryDelay(options.tries);
    if (scheduled === null) return null;
    base = scheduled;
  } else {
    base = Math.max(server, retryStep(options.tries));
  }
  const spread = Math.min(Math.max(options.random, 0), 1);
  const delay = Math.round(base * (1 + JITTER * spread));
  return options.waited + delay > RETRY_WINDOW_MS ? null : delay;
}

/** What GET …/pages answers, with the wait the server may suggest. */
type PagesAnswer = DocumentPagesDto & { retryAfter?: unknown };

export function useDocumentPages(
  target: MaybeRefOrGetter<DocumentPagesTarget | null>,
) {
  const api = useApi();
  const pages = shallowRef<DocumentPagesDto | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  /** The time scheduled between asks since the first one for `asked`. */
  let waited = 0;
  let asked = "";
  /** An ask that fell due while the tab was hidden. */
  let deferred: (() => void) | null = null;

  function onVisibility(): void {
    if (document.visibilityState !== "visible" || !deferred) return;
    const run = deferred;
    stopWaiting();
    run();
  }

  function stopWaiting(): void {
    if (!deferred) return;
    deferred = null;
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    stopWaiting();
  }

  /** Asks now, or once the tab shows when it is hidden. */
  function ask(current: DocumentPagesTarget, id: string): void {
    if (document.visibilityState !== "hidden") {
      void load(current, id);
      return;
    }
    if (deferred) return;
    deferred = () => {
      if (asked === id) void load(current, id);
    };
    document.addEventListener("visibilitychange", onVisibility);
  }

  async function load(current: DocumentPagesTarget, id: string) {
    try {
      const dto = await api.get<PagesAnswer>(
        `/api/assemblies/${encodeURIComponent(current.assembly)}/documents/${encodeURIComponent(current.document)}/pages`,
      );
      if (asked !== id) return;
      pages.value = dto;
      // The first answer that is not pending ends the asking.
      const delay = dto.pending
        ? pagesAskDelay({
            tries,
            waited,
            retryAfter: dto.retryAfter,
            random: Math.random(),
          })
        : null;
      if (delay !== null) {
        tries += 1;
        waited += delay;
        timer = setTimeout(() => {
          timer = undefined;
          ask(current, id);
        }, delay);
      }
    } catch {
      // No numbers: the text reads the same.
    }
  }

  if (import.meta.client) {
    watch(
      () => toValue(target),
      (current) => {
        const id = current
          ? `${current.assembly}/${current.document}/${current.key}`
          : "";
        if (id === asked) return;
        clear();
        asked = id;
        tries = 0;
        waited = 0;
        // The previous document's numbers never show on another one.
        if (!current) pages.value = null;
        else ask(current, id);
      },
      { immediate: true },
    );
    onScopeDispose(clear);
  }

  return { pages };
}

/**
 * What to read for a document on show: only a public text (published or
 * postponed) has the package's PDFs. The key follows what their layout
 * reads (versions, title, kind, the final vote as printed).
 */
export function documentPagesTarget(
  assembly: string | null | undefined,
  document:
    | Pick<
        DocumentDto,
        | "id"
        | "status"
        | "format"
        | "title"
        | "kind"
        | "baseVersion"
        | "consolidatedVersion"
        | "finalVote"
      >
    | null
    | undefined,
): DocumentPagesTarget | null {
  if (
    !assembly ||
    !document?.baseVersion ||
    !isPublicDocumentStatus(document.status) ||
    document.format !== "structured"
  ) {
    return null;
  }
  const vote = document.finalVote;
  return {
    assembly,
    document: document.id,
    key: JSON.stringify([
      document.baseVersion.id,
      document.consolidatedVersion?.id ?? null,
      document.title,
      document.kind,
      vote
        ? [
            vote.id,
            vote.result,
            vote.method,
            vote.majority,
            vote.unanimous,
            vote.inFavor,
            vote.against,
            vote.abstentions,
            vote.blank,
          ]
        : null,
    ]),
  };
}

/**
 * The pages a ContentView shows for `version`'s text: the map only when it
 * is that version's, with the version's blocks in order (so a page whose
 * block the view leaves out moves to the next one it shows).
 */
export function contentPages(
  map: PageMapDto | null | undefined,
  version: Pick<VersionDto, "id" | "blocks"> | null | undefined,
): ContentPages | null {
  if (!map || !version || map.versionId !== version.id) return null;
  return {
    starts: map.starts,
    order: version.blocks.map((block) => block.id),
    total: map.total,
  };
}

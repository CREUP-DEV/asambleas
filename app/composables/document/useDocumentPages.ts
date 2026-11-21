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
 * it asks again, further apart each time (pagesRetryDelay). A failure
 * leaves no numbers: the text reads the same without them.
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

/**
 * The wait before the next ask after `tries` asks that answered `pending`:
 * 20 s, 40 s, then a minute each time, or null once the next ask would fall
 * past RETRY_WINDOW_MS from the first.
 */
export function pagesRetryDelay(tries: number): number | null {
  let waited = 0;
  for (let index = 0; ; index += 1) {
    const delay = Math.min(RETRY_MS * (index + 1), MAX_RETRY_MS);
    if (waited + delay > RETRY_WINDOW_MS) return null;
    if (index >= tries) return delay;
    waited += delay;
  }
}

export function useDocumentPages(
  target: MaybeRefOrGetter<DocumentPagesTarget | null>,
) {
  const api = useApi();
  const pages = shallowRef<DocumentPagesDto | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  let asked = "";

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  async function load(current: DocumentPagesTarget, id: string) {
    try {
      const dto = await api.get<DocumentPagesDto>(
        `/api/assemblies/${encodeURIComponent(current.assembly)}/documents/${encodeURIComponent(current.document)}/pages`,
      );
      if (asked !== id) return;
      pages.value = dto;
      const delay = dto.pending ? pagesRetryDelay(tries) : null;
      if (delay !== null) {
        tries += 1;
        timer = setTimeout(() => void load(current, id), delay);
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
        // The previous document's numbers never show on another one.
        if (!current) pages.value = null;
        else void load(current, id);
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
  };
}

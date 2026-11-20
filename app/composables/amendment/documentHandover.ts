import {
  getCurrentInstance,
  getCurrentScope,
  onScopeDispose,
  type Ref,
} from "vue";
import type { DocumentAmendmentsDto, DocumentDto } from "~~/shared/types/api";

/**
 * Handing a document and its amendments from one page to the next (NAV-2).
 *
 * Directo and the document pages read the same requests (GET
 * .../documents/{document} and GET .../documents/{document}/amendments, no
 * query, as the same account) under keys of their own: Directo knows the
 * document by its id, the document page by the route's slugs. They cannot
 * share one fetch key: whichever page creates a key's entry supplies the
 * handler for every later refresh of it, and Nuxt hands that handler no
 * key, so it reads the page's own state (Directo's live state, purged once
 * it unmounts).
 *
 * So each page keeps its keys and, on a client navigation, seeds a fresh
 * entry with what the page it leaves still holds (it stays mounted until
 * the new one is ready), instead of downloading it again. Only data that
 * page shows as up to date is handed over: read, its last read not failed,
 * no read of it on its way (DocumentHandoverSource), and only while the
 * live stream is connected (followingLive), so every live event since is
 * one the new page, subscribed in the same setup, follows itself. Never on
 * the server or while hydrating.
 */

/** What a page holding a document offers the next one (Directo, the workspace). */
export interface DocumentHandoverSource {
  /** The assembly's id. */
  assemblyId: () => string | null | undefined;
  /**
   * The document, only while its fetch settled with it and is not stale
   * (settledForHandover); null otherwise.
   */
  document: () => DocumentDto | null | undefined;
  /** Its amendments, under the same conditions; null otherwise. */
  amendments: () => DocumentAmendmentsDto | null | undefined;
}

/** What a page takes over: the document, and its amendments when they are good too. */
export interface DocumentHandover {
  document: DocumentDto;
  amendments: DocumentAmendmentsDto | null;
}

/**
 * Whether a fetch's data can be handed over: it read successfully, the
 * last read did not fail, and no read of it (a partial one included) is on
 * its way, which may bring a change the next page would never hear of.
 */
export function settledForHandover(state: {
  status: string;
  failed: boolean;
  busy?: boolean;
}): boolean {
  return state.status === "success" && !state.failed && !state.busy;
}

/** The live stream's state, as the hub keeps it (useCurrentAssembly().live). */
export interface LiveStreamState {
  connected: Readonly<Ref<boolean>>;
  polling: Readonly<Ref<boolean>>;
  expired: Readonly<Ref<boolean>>;
}

/**
 * Whether the pages follow every change as it happens: the stream is
 * connected, not polling and not expired. Otherwise a page may have missed
 * events (a reconnection's `ready` or the next poll catches up, an expired
 * stream never), so the next one reads as it would without a handover.
 */
export function followingLive(state: {
  connected: boolean;
  polling: boolean;
  expired: boolean;
}): boolean {
  return state.connected && !state.polling && !state.expired;
}

/**
 * Adds a source to a registry until the current effect scope is disposed.
 * Nothing without a scope, or in one already stopped: a page left while its
 * setup awaited still runs the rest of it, inside its stopped scope, where
 * the cleanup would never run and the source would outlive the page.
 * Answers whether it added it.
 */
export function addSource(
  sources: Set<DocumentHandoverSource>,
  source: DocumentHandoverSource,
): boolean {
  const scope = getCurrentScope();
  if (!scope?.active || getCurrentInstance()?.isUnmounted) return false;
  sources.add(source);
  onScopeDispose(() => {
    sources.delete(source);
  });
  return true;
}

/**
 * Whether an amendments list is this document's: the same base text and
 * every amendment of it. A list kept from another document never passes.
 */
export function amendmentsBelongTo(
  list: DocumentAmendmentsDto,
  document: DocumentDto,
): boolean {
  return (
    list.baseVersionId === (document.baseVersion?.id ?? null) &&
    list.amendments.every((amendment) => amendment.documentId === document.id)
  );
}

/**
 * The newest source holding this document of this assembly, by the
 * document's id or slug (a route param may be either), or null. The
 * amendments come only with the document they belong to.
 */
export function findDocumentHandover(
  sources: Iterable<DocumentHandoverSource>,
  assemblyId: string | null | undefined,
  documentRef: string | null | undefined,
): DocumentHandover | null {
  if (!assemblyId || !documentRef) return null;
  let found: DocumentHandover | null = null;
  for (const source of sources) {
    if (source.assemblyId() !== assemblyId) continue;
    const document = source.document();
    if (!document) continue;
    if (document.id !== documentRef && document.slug !== documentRef) continue;
    const amendments = source.amendments() ?? null;
    found = {
      document,
      amendments:
        amendments && amendmentsBelongTo(amendments, document)
          ? amendments
          : null,
    };
  }
  return found;
}

/**
 * Whether a fetch entry can take a handed-over value: a fresh one, never
 * read (idle, no data). One another component of the page already holds is
 * left as it is.
 */
export function canSeed(status: string, data: unknown): boolean {
  return status === "idle" && (data === undefined || data === null);
}

/**
 * Puts a handed-over value in a fresh fetch entry, created with
 * `immediate: false`, as if it had just been read (status "success").
 * Call it right after useAsyncData / useFetch and before keepLastGoodData,
 * which then counts it as good data. Answers whether it did.
 */
export function seedFetch<T>(
  fetch: { data: Ref<T>; status: Ref<string> },
  value: T | null | undefined,
): boolean {
  if (value === null || value === undefined) return false;
  if (!canSeed(fetch.status.value, fetch.data.value)) return false;
  fetch.data.value = value;
  fetch.status.value = "success";
  return true;
}

/**
 * seedFetch for a fetch created with `immediate: false` because a value
 * was handed over: when it cannot take it and was never read (idle), it is
 * read now, as it would have been without the handover. Answers whether
 * it seeded.
 */
export function seedOrRead<T>(
  fetch: {
    data: Ref<T>;
    status: Ref<string>;
    refresh: () => Promise<unknown>;
  },
  value: T | null | undefined,
): boolean {
  if (seedFetch(fetch, value)) return true;
  if (fetch.status.value === "idle") void fetch.refresh();
  return false;
}

/** The sources of each app (per nuxtApp, so per tab), client-side only. */
const registries = new WeakMap<object, Set<DocumentHandoverSource>>();

export interface DocumentHandoverRegistry {
  /**
   * Offers this page's document until its setup scope is disposed; nothing
   * from a page already left (addSource).
   */
  register: (source: DocumentHandoverSource) => void;
  /**
   * What a page still mounted holds of this document (findDocumentHandover),
   * only while the live stream is connected (followingLive).
   */
  find: (
    assemblyId: string | null | undefined,
    documentRef: string | null | undefined,
  ) => DocumentHandover | null;
}

/**
 * The registry of the pages that hold a document. Call it in setup (before
 * any await), with the hub's live stream. Nothing is registered or found on
 * the server or while the page hydrates: what the server rendered is read
 * as it came.
 */
export function useDocumentHandover(
  live: LiveStreamState,
): DocumentHandoverRegistry {
  const nuxtApp = useNuxtApp();
  if (import.meta.server) {
    return { register: () => {}, find: () => null };
  }
  let sources = registries.get(nuxtApp);
  if (!sources) {
    sources = new Set();
    registries.set(nuxtApp, sources);
  }
  const own = sources;
  return {
    register(source) {
      addSource(own, source);
    },
    find(assemblyId, documentRef) {
      if (nuxtApp.isHydrating) return null;
      const following = followingLive({
        connected: live.connected.value,
        polling: live.polling.value,
        expired: live.expired.value,
      });
      if (!following) return null;
      return findDocumentHandover(own, assemblyId, documentRef);
    },
  };
}

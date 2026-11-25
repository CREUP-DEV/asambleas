import type { MaybeRefOrGetter, Ref } from "vue";
import type { DocumentDto, LiveEventDto } from "~~/shared/types/api";
import { affectsDocumentDto } from "../assembly/-liveFilters";
import { requireCurrentAssembly } from "../assembly/useCurrentAssembly";
import { seedOrRead, settledForHandover } from "../amendment/documentHandover";
import { keepLastGoodData, useStaleDataNotice } from "../fetch/lastGoodData";

export interface UseDocumentOptions {
  /**
   * Refetch on live events of this document (default true), through the
   * assembly hub's stream (`onLive`): it then runs only inside the hub, and
   * throws elsewhere. Pass false for a frozen text, or to wire
   * `handleLiveEvents` by hand.
   */
  live?: boolean;
  /**
   * This document as a page still mounted holds it (documentHandover):
   * shown at once instead of read again. Only on a client navigation, and
   * only this document's (the caller matched it to the params).
   */
  seed?: DocumentDto | null;
}

export interface UseDocumentReturn {
  /**
   * The document; undefined until it first loads, or when it is gone (404).
   * A failed refresh keeps the last good document, so the editor or the
   * composer showing it is never unmounted. Writable: store mutation
   * responses (a full DocumentDto) here so `updatedAt` and
   * `workingVersion.contentHash` stay current for the next request.
   */
  document: Ref<DocumentDto | undefined>;
  pending: Ref<boolean>;
  /** The last request's error; with `document` set, the refresh failed. */
  error: Ref<unknown>;
  /** True while the last refresh failed and the last good document shows. */
  stale: Readonly<Ref<boolean>>;
  refresh: () => Promise<void>;
  /**
   * Refetches when a batch may change this DocumentDto (affectsDocumentDto),
   * or asks to poll.
   */
  handleLiveEvents: (events: LiveEventDto[]) => void;
  /**
   * The document when the next page can take it over (documentHandover):
   * read, not failed, no read on its way; null otherwise.
   */
  handoverData: () => DocumentDto | null;
}

/**
 * One document of an assembly (GET /api/assemblies/{assembly}/documents/{document}),
 * kept fresh through live events. Both params accept a slug or an id.
 *
 * Shared fetch key: `document:{assembly}:{document}`, so every component of
 * a page that asks for the same document shares one request and one state.
 *
 * A failed refresh shows a warning toast and keeps the last good document.
 * With `seed`, a fresh key starts from it and is not read until a live
 * event, a refresh or another key asks for it.
 *
 * The result can be awaited (to have the data before rendering, e.g. to
 * redirect during SSR) or used directly.
 */
export function useDocument(
  assembly: MaybeRefOrGetter<string | undefined>,
  document: MaybeRefOrGetter<string | undefined>,
  options: UseDocumentOptions = {},
): UseDocumentReturn & Promise<UseDocumentReturn> {
  const assemblyParam = computed(() => toValue(assembly) ?? "");
  const documentParam = computed(() => toValue(document) ?? "");

  const hasParams = Boolean(assemblyParam.value && documentParam.value);
  // Only a seed of the document the params name (by id or slug).
  const seed =
    hasParams &&
    options.seed &&
    (options.seed.id === documentParam.value ||
      options.seed.slug === documentParam.value)
      ? options.seed
      : null;
  const asyncData = useFetch<DocumentDto>(
    () =>
      `/api/assemblies/${encodeURIComponent(assemblyParam.value)}/documents/${encodeURIComponent(documentParam.value)}`,
    {
      key: () => `document:${assemblyParam.value}:${documentParam.value}`,
      immediate: hasParams && !seed,
    },
  );
  // Before keepLastGoodData, which then counts it as good. A key that
  // another component of the page already holds is left alone, one never
  // read is read now (seedOrRead). Not read again until something asks:
  // the page's params, and so its key, stay the same while it is mounted.
  if (seed) seedOrRead(asyncData, seed);

  const { data, stale, failed } = keepLastGoodData(asyncData, {
    resetOn: () => `${assemblyParam.value}:${documentParam.value}`,
  });
  useStaleDataNotice(stale);

  async function refresh(): Promise<void> {
    if (!assemblyParam.value || !documentParam.value) return;
    await asyncData.refresh();
  }

  function handleLiveEvents(events: LiveEventDto[]): void {
    if (affectsDocumentDto(events, data.value?.id, data.value?.finalVote?.id)) {
      void refresh();
    }
  }

  if (options.live !== false) {
    // One stream per tab, the hub's (useCurrentAssembly): never one of its own.
    requireCurrentAssembly("useDocument").onLive(handleLiveEvents);
  }

  const result: UseDocumentReturn = {
    document: data,
    pending: asyncData.pending as Ref<boolean>,
    error: asyncData.error as Ref<unknown>,
    stale,
    refresh,
    handleLiveEvents,
    handoverData: () =>
      settledForHandover({
        status: asyncData.status.value,
        failed: failed.value,
      })
        ? (data.value ?? null)
        : null,
  };

  const promise = Promise.resolve(asyncData).then(() => result);
  return Object.assign(promise, result);
}

import type { MaybeRefOrGetter, Ref } from "vue";
import type { DocumentDto, LiveEventDto } from "~~/shared/types/api";
import { CURRENT_ASSEMBLY_KEY } from "../assembly/useCurrentAssembly";
import { keepLastGoodData, useStaleDataNotice } from "../fetch/lastGoodData";
import { useAssemblyLive } from "../live/useAssemblyLive";

export interface UseDocumentOptions {
  /**
   * Refetch on live events of this document (default true). Inside the
   * assembly hub it subscribes to the hub's stream (`onLive`); elsewhere it
   * opens its own. Pass false to wire `handleLiveEvents` by hand.
   */
  live?: boolean;
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
  /** Refetches when a batch touches this document, or asks to poll. */
  handleLiveEvents: (events: LiveEventDto[]) => void;
}

/** Whether a live batch concerns the document with this id. */
export function isDocumentLiveBatch(
  events: LiveEventDto[],
  documentId: string | undefined,
): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      (documentId !== undefined &&
        (event.documentId === documentId ||
          (event.entityType === "document" && event.entityId === documentId))),
  );
}

/**
 * One document of an assembly (GET /api/assemblies/{assembly}/documents/{document}),
 * kept fresh through live events. Both params accept a slug or an id.
 *
 * Shared fetch key: `document:{assembly}:{document}`, so every component of
 * a page that asks for the same document shares one request and one state.
 *
 * A failed refresh shows a warning toast and keeps the last good document.
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

  const asyncData = useFetch<DocumentDto>(
    () =>
      `/api/assemblies/${encodeURIComponent(assemblyParam.value)}/documents/${encodeURIComponent(documentParam.value)}`,
    {
      key: () => `document:${assemblyParam.value}:${documentParam.value}`,
      immediate: Boolean(assemblyParam.value && documentParam.value),
    },
  );

  const { data, stale } = keepLastGoodData(asyncData, {
    resetOn: () => `${assemblyParam.value}:${documentParam.value}`,
  });
  useStaleDataNotice(stale);

  async function refresh(): Promise<void> {
    if (!assemblyParam.value || !documentParam.value) return;
    await asyncData.refresh();
  }

  function handleLiveEvents(events: LiveEventDto[]): void {
    if (isDocumentLiveBatch(events, data.value?.id)) void refresh();
  }

  if (options.live !== false) {
    // One stream per tab: reuse the hub's when this runs inside it.
    const hub = inject(CURRENT_ASSEMBLY_KEY, null);
    if (hub) {
      hub.onLive(handleLiveEvents);
    } else {
      useAssemblyLive(() => assemblyParam.value || undefined, handleLiveEvents);
    }
  }

  const result: UseDocumentReturn = {
    document: data,
    pending: asyncData.pending as Ref<boolean>,
    error: asyncData.error as Ref<unknown>,
    stale,
    refresh,
    handleLiveEvents,
  };

  const promise = Promise.resolve(asyncData).then(() => result);
  return Object.assign(promise, result);
}

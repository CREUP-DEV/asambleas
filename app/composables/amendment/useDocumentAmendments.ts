import type { MaybeRefOrGetter } from "vue";
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  LiveEventDto,
  MemberRef,
} from "~~/shared/types/api";
import { CURRENT_ASSEMBLY_KEY } from "../assembly/useCurrentAssembly";
import { isDocumentLiveBatch } from "../document/useDocument";
import { keepLastGoodData, useStaleDataNotice } from "../fetch/lastGoodData";
import { useAssemblyLive } from "../live/useAssemblyLive";
import {
  amendmentBlockMarkers,
  amendmentDisplayLabel,
  amendmentOverlapIndex,
  amendmentRelationsOf,
  amendmentShortLabel,
  emptyAmendmentFilters,
  filterAmendmentList,
  groupAmendmentsByOverlap,
  mineAmendments,
  sortAmendments,
  type AmendmentFilters,
} from "./workspace";

export interface UseDocumentAmendmentsOptions {
  /** Assembly slug or id, for the API url. */
  assembly: MaybeRefOrGetter<string | undefined>;
  /** Document slug or id, for the API url. */
  document: MaybeRefOrGetter<string | undefined>;
  /**
   * Assembly id (not the slug), for a stream of its own when this runs
   * outside the assembly hub. Inside the hub its stream is reused.
   */
  assemblyId?: MaybeRefOrGetter<string | undefined>;
  /** Document id, to recognise the live events that concern it. */
  documentId?: MaybeRefOrGetter<string | undefined>;
}

/**
 * The amendments of one document as the actor sees them
 * (GET .../documents/{document}/amendments), with everything the workspace
 * derives from them: text order, overlap clusters, gutter markers, filters
 * and the actor's drafts. Refreshes itself on live events for the document.
 *
 * The main list leaves drafts out; `mine` holds the actor's drafts and
 * every amendment their member presents, whatever its review state.
 */
export function useDocumentAmendments(options: UseDocumentAmendmentsOptions) {
  const { t } = useI18n();
  const api = useApi();
  const { member } = useMe();

  const url = computed(() => {
    const assembly = toValue(options.assembly);
    const document = toValue(options.document);
    if (!assembly || !document) return null;
    return `/api/assemblies/${encodeURIComponent(assembly)}/documents/${encodeURIComponent(document)}/amendments`;
  });

  const amendmentsFetch = useAsyncData<DocumentAmendmentsDto | null>(
    computed(() => `document-amendments:${url.value ?? "none"}`),
    () =>
      url.value
        ? api.get<DocumentAmendmentsDto>(url.value)
        : Promise.resolve(null),
    { default: () => null },
  );
  const { status, error, refresh } = amendmentsFetch;
  // A failed poll keeps the list (and the composer or detail open on it);
  // switching documents forgets it.
  const { data, stale } = keepLastGoodData(amendmentsFetch, { resetOn: url });
  useStaleDataNotice(stale);

  const pending = computed(() => status.value === "pending");

  const amendments = computed<AmendmentDto[]>(() =>
    sortAmendments(data.value?.amendments ?? []),
  );
  const relations = computed(() => data.value?.relations ?? []);
  const byId = computed(
    () =>
      new Map(amendments.value.map((amendment) => [amendment.id, amendment])),
  );

  /** Everything but drafts: what the list, markers and clusters show. */
  const listed = computed(() =>
    amendments.value.filter((amendment) => amendment.status !== "draft"),
  );
  const mine = computed(() =>
    mineAmendments(amendments.value, member.value?.id ?? null),
  );

  const overlaps = computed(() => amendmentOverlapIndex(amendments.value));
  // From the listed amendments, so a marker and the list it filters agree.
  const markers = computed(() => amendmentBlockMarkers(listed.value));

  const filters = ref<AmendmentFilters>(emptyAmendmentFilters());
  const filtered = computed(() =>
    filterAmendmentList(listed.value, filters.value, member.value?.id ?? null),
  );
  const groups = computed(() => groupAmendmentsByOverlap(filtered.value));

  function resetFilters(): void {
    filters.value = emptyAmendmentFilters();
  }

  /** Every member presenting at least one listed amendment, by acronym. */
  const authorOptions = computed<MemberRef[]>(() => {
    const seen = new Map<string, MemberRef>();
    for (const amendment of listed.value) {
      for (const author of amendment.authors) seen.set(author.id, author);
    }
    return [...seen.values()].sort((a, b) =>
      a.acronym.localeCompare(b.acronym),
    );
  });

  /** "12 · CEUM 4", or "Borrador" for unnumbered drafts. */
  function labelOf(id: string): string {
    const amendment = byId.value.get(id);
    if (!amendment) return t("amendment.unknownAmendment");
    return amendmentDisplayLabel(amendment) ?? t("amendment.draftLabel");
  }

  /** Short reference for provenance marks ("CEUM 4", "T1"). */
  function shortLabelOf(id: string): string {
    const amendment = byId.value.get(id);
    if (!amendment) return "?";
    return amendmentShortLabel(amendment) ?? t("amendment.draftShort");
  }

  function relationsOf(id: string) {
    return amendmentRelationsOf(id, relations.value);
  }

  /** Puts a mutation's answer in place right away; a refresh follows. */
  function upsert(amendment: AmendmentDto): void {
    const current = data.value;
    if (!current) return;
    const list = current.amendments.filter((item) => item.id !== amendment.id);
    list.push(amendment);
    data.value = { ...current, amendments: list };
  }

  /**
   * Takes a full answer of the amendments API (validation and publication
   * return the whole list), keeping the current one when it is for another
   * document.
   */
  function replace(dto: DocumentAmendmentsDto): void {
    const current = data.value;
    if (current && current.baseVersionId !== dto.baseVersionId) return;
    data.value = dto;
  }

  function remove(id: string): void {
    const current = data.value;
    if (!current) return;
    data.value = {
      ...current,
      amendments: current.amendments.filter((item) => item.id !== id),
      relations: current.relations.filter(
        (relation) => relation.fromId !== id && relation.toId !== id,
      ),
    };
  }

  function handleLiveEvents(events: LiveEventDto[]): void {
    if (isDocumentLiveBatch(events, toValue(options.documentId))) {
      void refresh();
    }
  }

  // One stream per tab: reuse the hub's when this runs inside it.
  const hub = inject(CURRENT_ASSEMBLY_KEY, null);
  const live = hub
    ? (hub.onLive(handleLiveEvents), hub.live)
    : useAssemblyLive(
        () => (options.assemblyId ? toValue(options.assemblyId) : undefined),
        handleLiveEvents,
      );

  return {
    data,
    stale,
    status,
    pending,
    error,
    refresh,
    amendments,
    listed,
    mine,
    relations,
    byId,
    overlaps,
    markers,
    filters,
    filtered,
    groups,
    resetFilters,
    authorOptions,
    labelOf,
    shortLabelOf,
    relationsOf,
    upsert,
    replace,
    remove,
    live,
  };
}

export type DocumentAmendments = ReturnType<typeof useDocumentAmendments>;

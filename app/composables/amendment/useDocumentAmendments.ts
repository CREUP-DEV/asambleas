import type { MaybeRefOrGetter } from "vue";
import { isAmendmentLeft } from "~~/shared/utils/readMarks";
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  LiveEventDto,
  MemberRef,
  PartialDocumentAmendmentsDto,
} from "~~/shared/types/api";
import { CURRENT_ASSEMBLY_KEY } from "../assembly/useCurrentAssembly";
import { affectsDocumentAmendments } from "../assembly/-liveFilters";
import { keepLastGoodData, useStaleDataNotice } from "../fetch/lastGoodData";
import { trailingRefresh } from "../fetch/trailingRefresh";
import { useAssemblyLive } from "../live/useAssemblyLive";
import { seedOrRead, settledForHandover } from "./documentHandover";
import { partialAmendmentsRefetch } from "./partialAmendments";
import {
  amendmentBlockMarkers,
  amendmentDisplayLabel,
  amendmentOverlapIndex,
  amendmentRelationsOf,
  amendmentShortLabel,
  amendmentsReturnedForCorrection,
  emptyAmendmentFilters,
  filterAmendmentList,
  groupAmendmentsByOverlap,
  mineAmendments,
  openingAmendmentFilters,
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
  /**
   * The main presenter's answers to the document's amendments are public
   * (positionsArePublic): the list on screen (`groups`) is then grouped by
   * them (accepted, rejected, the rest), each group in text order. Text
   * order alone when omitted, and always for `amendments`, `listed` and
   * `mine`.
   */
  byAnswer?: MaybeRefOrGetter<boolean>;
  /**
   * The room's reading of the list (the document page): a live event of a
   * few amendments reads only those (partialAmendmentsRefetch). Off, every
   * event of the document and the assembly's status
   * (affectsDocumentAmendments) read the whole list again, as the
   * validation inbox needs, since it acts on it.
   */
  partialLive?: boolean;
  /**
   * This document's list as a page still mounted holds it
   * (documentHandover): shown at once instead of read again. Only on a
   * client navigation, only with fixed params, and only the list of this
   * document (findDocumentHandover matched it).
   */
  seed?: DocumentAmendmentsDto | null;
}

/**
 * The amendments of one document as the actor sees them
 * (GET .../documents/{document}/amendments), with everything the workspace
 * derives from them: text order, overlap clusters (`groups`, the list on
 * screen, grouped by the main presenter's answer once public:
 * `byAnswer`), gutter markers, filters
 * and the actor's drafts. Refreshes itself on live events for the document.
 *
 * The main list leaves drafts out; `mine` holds the actor's drafts and
 * every amendment their member presents, whatever its review state.
 * `returned` holds the drafts sent back for correction the actor cannot edit
 * (what the Secretaría returned): the list shows them, and only them, while
 * the review filter is `correction_requested`.
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

  const fetchKey = computed(() => `document-amendments:${url.value ?? "none"}`);
  const seed = url.value ? (options.seed ?? null) : null;
  const amendmentsFetch = useAsyncData<DocumentAmendmentsDto | null>(
    fetchKey,
    () =>
      url.value
        ? api.get<DocumentAmendmentsDto>(url.value)
        : Promise.resolve(null),
    { default: () => null, immediate: !seed },
  );
  // Before keepLastGoodData, which then counts it as good; a key another
  // component of the page already holds is left alone, one never read is
  // read now (seedOrRead). Not read again until a live event, a write or a
  // refresh asks for it.
  if (seed) seedOrRead(amendmentsFetch, seed);
  const { status, error, refresh } = amendmentsFetch;
  // A failed poll keeps the list (and the composer or detail open on it);
  // switching documents forgets it.
  const { data, stale, failed } = keepLastGoodData(amendmentsFetch, {
    resetOn: url,
  });
  useStaleDataNotice(stale);

  const pending = computed(() => status.value === "pending");

  // Text order: what the pickers, the composer and `mine` read. Only the
  // list on screen (`groups`) is grouped by the answers once public.
  const amendments = computed<AmendmentDto[]>(() =>
    sortAmendments(data.value?.amendments ?? []),
  );
  const order = computed(() => ({
    byAnswer: toValue(options.byAnswer) ?? false,
  }));
  const relations = computed(() => data.value?.relations ?? []);
  /** The Mesa's wordings of passages where approved amendments collide. */
  const wordings = computed(() => data.value?.wordings ?? []);
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
  /** Sent back for correction, seen by someone who cannot edit them. */
  const returned = computed(() =>
    amendmentsReturnedForCorrection(amendments.value),
  );

  const overlaps = computed(() => amendmentOverlapIndex(amendments.value));
  // From the listed amendments, so a marker and the list it filters agree.
  const markers = computed(() => amendmentBlockMarkers(listed.value));

  /**
   * What the list opens on, until the reader picks something else: the
   * content amendments ("Contenido") when there are some, otherwise every
   * one ("Todas"), so it never opens on an empty "Contenido". Worked out
   * from the amendments rather than written once they arrive, so the page
   * rendered on the server and the one in the browser always agree. Another
   * document starts over.
   */
  const openingFilters = computed<AmendmentFilters>(() =>
    openingAmendmentFilters(listed.value),
  );
  /** What the reader picked; null while it is still the opening filter. */
  const chosenFilters = ref<AmendmentFilters | null>(null);
  watch(url, () => {
    chosenFilters.value = null;
  });
  const filters = computed<AmendmentFilters>({
    get: () => chosenFilters.value ?? openingFilters.value,
    set: (value) => {
      chosenFilters.value = value;
    },
  });

  // "Sin leer": the listed amendments the account still has to read (its
  // read marks: published, undecided, not its member's own).
  const marks = useReadMarks();
  const isLeft = (id: string) => {
    const mark = marks.amendment(id);
    return mark !== null && isAmendmentLeft(mark);
  };
  const unreadIds = computed(() =>
    listed.value.map((amendment) => amendment.id).filter(isLeft),
  );
  /**
   * While the filter is on, an amendment marked as read stays in the list
   * until the filter goes: the reader does not lose their place.
   */
  const unreadKept = ref<ReadonlySet<string>>(new Set());
  watch(
    [() => filters.value.unread, unreadIds],
    ([on, ids]) => {
      if (!on) {
        if (unreadKept.value.size > 0) unreadKept.value = new Set();
        return;
      }
      if (ids.every((id) => unreadKept.value.has(id))) return;
      unreadKept.value = new Set([...unreadKept.value, ...ids]);
    },
    { immediate: true },
  );
  /**
   * What the list draws from: the listed amendments, or the returned drafts
   * while the review filter asks for them. Markers, counts and the overlap
   * index keep to the listed ones.
   */
  const source = computed(() =>
    filters.value.review === "correction_requested"
      ? returned.value
      : listed.value,
  );
  const filtered = computed(() =>
    filterAmendmentList(
      source.value,
      filters.value,
      member.value?.id ?? null,
      (id) => unreadKept.value.has(id) || isLeft(id),
    ),
  );
  const groups = computed(() =>
    groupAmendmentsByOverlap(filtered.value, order.value),
  );

  // Nothing left sent back (fixed and sent again, or another document): show
  // the whole list again rather than an empty filtered one.
  watch(
    () => returned.value.length === 0,
    (none) => {
      if (none && filters.value.review === "correction_requested") {
        filters.value = { ...filters.value, review: "any" };
      }
    },
  );

  /** "Quitar filtros": every amendment, as "Todas". */
  function resetFilters(): void {
    filters.value = emptyAmendmentFilters();
  }

  /** Every member presenting at least one amendment of the list, by acronym. */
  const authorOptions = computed<MemberRef[]>(() => {
    const seen = new Map<string, MemberRef>();
    for (const amendment of source.value) {
      for (const author of amendment.authors) seen.set(author.id, author);
    }
    return [...seen.values()].sort((a, b) =>
      a.acronym.localeCompare(b.acronym),
    );
  });

  /** "12 · CEUM 4", or "Borrador" for unnumbered drafts. */
  function labelOf(id: string): string {
    const amendment = byId.value.get(id);
    if (!amendment) {
      return wordings.value.some((wording) => wording.id === id)
        ? t("amendment.mesaWording")
        : t("amendment.unknownAmendment");
    }
    // Numbered on publication: sent and not published yet, it has none.
    return (
      amendmentDisplayLabel(amendment) ??
      t(
        amendment.status === "draft"
          ? "amendment.draftLabel"
          : "amendment.unnumberedLabel",
      )
    );
  }

  /** Short reference for provenance marks ("CEUM 4", "T1"). */
  function shortLabelOf(id: string): string {
    const amendment = byId.value.get(id);
    if (!amendment) {
      return wordings.value.some((wording) => wording.id === id)
        ? t("amendment.mesaWording")
        : "?";
    }
    return amendmentShortLabel(amendment) ?? t("amendment.draftShort");
  }

  function relationsOf(id: string) {
    return amendmentRelationsOf(id, relations.value);
  }

  // One stream per tab: reuse the hub's when this runs inside it.
  const hub = inject(CURRENT_ASSEMBLY_KEY, null);
  const nuxtApp = useNuxtApp();

  /**
   * A mutation's answer was just written (CON-10): a read of the list that
   * left before it would land after it and bring back what it replaced, so
   * that read is replaced by one that leaves now (cancel). With nothing on
   * its way it reads nothing; the write's live event follows. A partial
   * read on its way reads its amendments again instead of landing.
   */
  function afterWrite(): void {
    partial?.wrote();
    if (status.value !== "pending") return;
    if (nuxtApp.isHydrating) {
      onNuxtReady(() => void refresh({ dedupe: "cancel" }));
    } else {
      void refresh({ dedupe: "cancel" });
    }
  }

  /** Puts a mutation's answer in place right away; a refresh follows. */
  function upsert(amendment: AmendmentDto): void {
    const current = data.value;
    if (!current) return;
    const list = current.amendments.filter((item) => item.id !== amendment.id);
    list.push(amendment);
    data.value = { ...current, amendments: list };
    afterWrite();
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
    afterWrite();
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
    afterWrite();
  }

  /**
   * Reads the whole list again after a live batch, never joining a read
   * that may have left before it: one run per batch for every reader of
   * the key inside the hub (liveRefresh), a trailing one of its own
   * outside it.
   */
  const ownRefresh = trailingRefresh(() => refresh({ dedupe: "cancel" }));
  /**
   * Live reads asked for and not settled yet: one starts a microtask later
   * (trailingRefresh), and the list must not be handed over meanwhile.
   */
  let liveReads = 0;
  function refreshAll(): Promise<unknown> {
    liveReads += 1;
    const read = hub
      ? hub.liveRefresh(fetchKey.value, () => refresh({ dedupe: "cancel" }))
      : ownRefresh();
    return read.finally(() => {
      liveReads -= 1;
    });
  }

  // The room's reading: only what a batch changed when it can (REC-4).
  const partial = options.partialLive
    ? partialAmendmentsRefetch({
        documentId: () => toValue(options.documentId),
        current: () => (failed.value ? null : data.value),
        write: (dto) => {
          data.value = dto;
        },
        refreshAll,
        readSome: (ids) =>
          url.value
            ? api.get<PartialDocumentAmendmentsDto>(url.value, {
                ids: ids.join(","),
              })
            : Promise.reject(new Error("No document")),
        readingAll: () => status.value === "pending",
      })
    : null;
  if (partial) {
    watch(
      status,
      (value) => {
        if (value === "pending") partial.readAllStarted();
      },
      { flush: "sync" },
    );
  }

  function handleLiveEvents(events: LiveEventDto[]): void {
    if (partial) {
      void partial.handle(events);
    } else if (affectsDocumentAmendments(events, toValue(options.documentId))) {
      void refreshAll();
    }
  }

  const live = hub
    ? (hub.onLive(handleLiveEvents), hub.live)
    : useAssemblyLive(
        () => (options.assemblyId ? toValue(options.assemblyId) : undefined),
        handleLiveEvents,
      );

  /**
   * The list when the next page can take it over (documentHandover): read,
   * its last read not failed, no read of it (a partial one included) on its
   * way; null otherwise.
   */
  function handoverData(): DocumentAmendmentsDto | null {
    return settledForHandover({
      status: status.value,
      failed: failed.value,
      busy: liveReads > 0 || (partial?.busy() ?? false),
    })
      ? (data.value ?? null)
      : null;
  }

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
    returned,
    unreadIds,
    source,
    relations,
    wordings,
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
    handoverData,
  };
}

export type DocumentAmendments = ReturnType<typeof useDocumentAmendments>;

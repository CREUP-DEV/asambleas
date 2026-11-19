<script setup lang="ts">
import type { TabsItem } from "@nuxt/ui";
import { ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AmendmentDto,
  ControlSheetAmendmentBody,
  ControlSheetAmendmentRowDto,
  ControlSheetDto,
  ControlSheetItemBody,
  ControlSheetItemRowDto,
  DocumentAmendmentsDto,
  LiveStateDto,
  MemberDto,
  VoteDto,
} from "~~/shared/types/api";
import {
  AMENDMENT_SORT_KEYS,
  AMENDMENT_SORT_LEADS,
  AMENDMENT_VIEWS,
  DEFAULT_AMENDMENT_SORT,
  DEFAULT_GENERAL_SORT,
  EMPTY_AMENDMENT_FILTERS,
  EMPTY_GENERAL_FILTERS,
  GENERAL_SORT_KEYS,
  GENERAL_SORT_LEADS,
  GENERAL_VIEWS,
  KIND_FILTERS,
  POSITION_LEADS,
  RESULT_FILTERS,
  SHEET_FILTER_QUERY_KEYS,
  SHEET_QUERY,
  VOTE_FILTERS,
  activeFilterCount,
  amendmentSheetQuery,
  clearedSheetQuery,
  filtersKey,
  generalSheetQuery,
  isDefaultSort,
  keepSeen,
  matchingAmendmentIds,
  matchingGeneralIds,
  nextSort,
  parseAmendmentSheetQuery,
  parseGeneralSheetQuery,
  shownAmendmentRows,
  shownGeneralRows,
  type AmendmentSheetFilters,
  type AmendmentSortKey,
  type GeneralSheetFilters,
  type GeneralSortKey,
  type KindFilter,
  type PositionLead,
  type ResultFilter,
  type VoteFilter,
  type SheetQueryPatch,
  type SheetSort,
} from "~/components/control-sheet/-filters";
import {
  affectsControlSheet,
  affectsLiveDebate,
  amendedDocuments,
  amendmentTreatedControl,
  buildAmendmentRows,
  buildGeneralRows,
  documentAgendaTrail,
  itemTreatedControl,
  staleSheetRow,
  type AgendaTrailStep,
  type AmendmentSheetRow,
  type GeneralSheetRow,
  type ItemVoteContext,
  type SheetRowDocument,
  type TreatedControl,
} from "~/components/control-sheet/-model";
import {
  LIVE_AMENDMENT_STATES,
  type LiveAmendmentState,
} from "~/components/live-view/-model";
import type { SheetFilterGroup } from "~/components/control-sheet/Toolbar.vue";
import { agendaItemPath } from "~/composables/document/agendaReturn";
import type { RowPanelTarget } from "~/components/control-sheet/RowPanel.vue";
import {
  buildAgendaTree,
  flattenAgendaTree,
  numberedAgendaTitle,
} from "~/utils/agendaTree";
import { positionsArePublic } from "~~/shared/utils/positions";

/**
 * The control sheet of the assembly (hoja de control), for the Mesa, the
 * CEA, the Secretaría and the Presidencia (control_sheet:view or :edit):
 * «General», one row per agenda item with documents, and «Enmiendas», the
 * amendments of one document. It replaces the spreadsheet they kept during
 * the session and feeds the minutes (docs/control-sheet-plan.md).
 *
 * Everyone else who sees the assembly reads it too (user's decision of
 * 2026-11-19), only what is public (ControlSheetDto.can.internal false):
 * «General» and «Enmiendas» without the treated mark, who spoke and the
 * observations, the presenter's answers once public, and neither «Turnos de
 * palabra» nor «Historial».
 *
 * The agenda comes from the hub (useAssemblyAgenda); the sheet's own answer
 * adds the final votes, the votes on items, the amendment counts and who
 * spoke. «Seguir el debate» opens what the Mesa has on screen and marks its
 * row. Each list sorts by its columns and filters (-filters.ts), both kept
 * in the query next to the tab and the document.
 */

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const route = useRoute();
const router = useRouter();
const { can } = useMe();
const { assembly, apiBase, sectionPath, onLive } = useCurrentAssembly();

useHead({
  title: () =>
    [t("controlSheet.title"), assembly.value?.label]
      .filter(Boolean)
      .join(" · "),
});

/**
 * Recording results from the sheet, never projected (the Mesa and
 * assembly:vote_result; user's decision of 2026-11-19).
 */
const canRecordResults = computed(
  () =>
    can(PERMISSION_KEYS.SESSION_MODERATE) ||
    can(PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT),
);

/** Noting who spoke (the Mesa and session:record_speakers). */
const canNoteSpeakers = computed(
  () =>
    can(PERMISSION_KEYS.SESSION_MODERATE) ||
    can(PERMISSION_KEYS.SESSION_RECORD_SPEAKERS),
);
/** Notes are taken from the convocation until the assembly closes. */
const speakerNotesOpen = computed(
  () =>
    assembly.value?.status === "convened" ||
    assembly.value?.status === "in_session",
);

const sheetFetch = useFetch<ControlSheetDto>(
  () => `${apiBase.value}/control-sheet`,
  {
    key: computed(() => `control-sheet-${assembly.value?.id ?? "none"}`),
    dedupe: "defer",
  },
);
const { data: sheet, stale } = keepLastGoodData(sheetFetch, {
  resetOn: () => assembly.value?.id,
});
useStaleDataNotice(stale);

const liveFetch = useFetch<LiveStateDto>(() => `${apiBase.value}/live-state`, {
  key: computed(() => `control-sheet-live-${assembly.value?.id ?? "none"}`),
  dedupe: "defer",
});

const agenda = useAssemblyAgenda();
await Promise.all([sheetFetch, liveFetch, agenda]);

/**
 * Every member, inactive ones too, for the card a presenter's tag opens
 * (its university and avatar). Lazy: the tags show without it.
 */
const membersFetch = useLazyFetch<MemberDto[]>("/api/members", {
  key: "control-sheet-members",
  query: { all: 1 },
  server: false,
  default: () => [],
});
const membersById = computed<ReadonlyMap<string, MemberDto>>(
  () =>
    new Map(
      (membersFetch.data.value ?? []).map((member) => [member.id, member]),
    ),
);

const live = computed(() => liveFetch.data.value ?? null);
/** A sheet key: its notes, turns and history (ControlSheetDto.can). */
const internal = computed(() => sheet.value?.can.internal ?? false);
const items = computed(() => agenda.data.value?.items ?? []);
const agendaDocuments = computed(() => agenda.data.value?.documents ?? []);

// Tabs and the document of «Enmiendas» live in the query ----------------------

type SheetTab = "general" | "amendments" | "turns" | "history";
/** The query value of each tab but «General», the default. */
const TAB_SLUGS: Partial<Record<SheetTab, string>> = {
  amendments: "enmiendas",
  turns: "turnos",
  history: "historial",
};
const TAB_QUERY = "vista";
const DOCUMENT_QUERY = "documento";

const tab = computed<SheetTab>({
  get: () => {
    const slug = route.query[TAB_QUERY];
    const match = (Object.keys(TAB_SLUGS) as SheetTab[]).find(
      (key) => TAB_SLUGS[key] === slug,
    );
    // The turns and the history are the sheet's own: a link to them opens
    // «General» to everyone else.
    if (!internal.value && (match === "turns" || match === "history")) {
      return "general";
    }
    return match ?? "general";
  },
  set: (value) => {
    void router.replace({ query: { ...route.query, ...tabQuery(value) } });
  },
});

/**
 * Each tab's order, filters and search as it left them (user's decision of
 * 2026-11-19): coming back to a tab finds them again, for as long as the
 * page stays open.
 */
const tabQueries = new Map<SheetTab, SheetQueryPatch>();

/** The order, filters and search in the query now. */
function currentSheetQuery(): SheetQueryPatch {
  return Object.fromEntries(
    SHEET_FILTER_QUERY_KEYS.map((key) => {
      const value = route.query[key];
      const first = Array.isArray(value) ? value[0] : value;
      return [key, typeof first === "string" && first ? first : undefined];
    }),
  );
}

/**
 * The query that opens a tab. Each tab sorts and filters by its own
 * columns: another tab starts as it was left, or in its default order,
 * unfiltered, with the search box empty, so a search typed a moment before
 * (still on its way to the query) is never written on the other tab.
 */
function tabQuery(value: SheetTab): SheetQueryPatch {
  if (value === tab.value) return {};
  tabQueries.set(tab.value, currentSheetQuery());
  clearSearchBox();
  return {
    ...clearedSheetQuery(),
    ...(tabQueries.get(value) ?? {}),
    [TAB_QUERY]: TAB_SLUGS[value],
  };
}
const tabItems = computed<TabsItem[]>(() => [
  { value: "general", label: t("controlSheet.tabs.general") },
  { value: "amendments", label: t("controlSheet.tabs.amendments") },
  ...(internal.value
    ? [
        { value: "turns", label: t("controlSheet.tabs.turns") },
        { value: "history", label: t("controlSheet.tabs.history") },
      ]
    : []),
]);

const documentOptions = computed(() =>
  amendedDocuments(agendaDocuments.value, sheet.value ?? null, items.value),
);
const selectedDocument = computed(() => {
  const wanted = route.query[DOCUMENT_QUERY];
  return (
    documentOptions.value.find(
      (document) => document.slug === wanted || document.id === wanted,
    ) ??
    documentOptions.value[0] ??
    null
  );
});
const selectItems = computed(() =>
  documentOptions.value.map((document) => ({
    value: document.id,
    label: document.title,
    description:
      document.undecided > 0
        ? t(
            "controlSheet.document.undecided",
            { count: document.undecided },
            document.undecided,
          )
        : t(
            "controlSheet.document.total",
            { count: document.amendments },
            document.amendments,
          ),
  })),
);
const selectedDocumentId = computed<string | undefined>({
  get: () => selectedDocument.value?.id,
  set: (id) => {
    const document = documentOptions.value.find((entry) => entry.id === id);
    if (!document) return;
    void router.replace({
      query: { ...route.query, [DOCUMENT_QUERY]: document.slug },
    });
  },
});

// Amendments of the chosen document ---------------------------------------------

const amendmentsUrl = computed(() =>
  selectedDocument.value
    ? `${apiBase.value}/documents/${encodeURIComponent(selectedDocument.value.id)}/amendments`
    : null,
);
type SheetAmendments = DocumentAmendmentsDto & { documentId: string };
const amendmentsFetch = useAsyncData<SheetAmendments | null>(
  computed(() => `control-sheet-amendments:${amendmentsUrl.value ?? "none"}`),
  async () => {
    const documentId = selectedDocument.value?.id;
    if (!amendmentsUrl.value || !documentId) return null;
    const dto = await api.get<DocumentAmendmentsDto>(amendmentsUrl.value);
    return { ...dto, documentId };
  },
  { default: () => null, lazy: true },
);
const { data: keptAmendments } = keepLastGoodData(amendmentsFetch, {
  resetOn: amendmentsUrl,
});
// Nuxt seeds a new key with the previous key's data until it lands: only
// the chosen document's amendments are ever shown under it.
const amendmentsData = onlyForKey(
  keptAmendments,
  () => selectedDocument.value?.id,
  (value) => value.documentId,
);

const generalRows = computed(() =>
  buildGeneralRows(
    items.value,
    agendaDocuments.value,
    sheet.value ?? null,
    live.value?.agendaItemId ?? null,
  ),
);
const amendmentRows = computed(() =>
  buildAmendmentRows(
    amendmentsData.value?.amendments ?? [],
    sheet.value?.sessionStartedAt ?? null,
    live.value?.amendmentId ?? null,
    sheet.value?.amendmentRows ?? [],
    sheet.value?.positions ?? [],
    sheet.value?.turns ?? [],
    // The console's order, by answer whether public or not yet.
    { byAnswer: true },
  ),
);

// Sorting and filtering, kept in the query ------------------------------------

/**
 * Whether the reader reads the presenter's answers to the chosen document's
 * amendments: with a sheet key, once they are public, or when the sheet
 * gives it some (its presenters read them before).
 */
const showPositions = computed(
  () =>
    internal.value ||
    (selectedDocument.value !== null &&
      positionsArePublic(selectedDocument.value)) ||
    amendmentRows.value.some((row) => row.position !== null),
);

/** Sort keys a reader without a sheet key has no column for. */
const INTERNAL_SORT_KEYS: ReadonlySet<string> = new Set([
  "treated",
  "speakers",
]);

/**
 * The state in the query as this reader may use it: without a sheet key,
 * no view but «Todas» and no sort by a column it does not have (a link
 * from someone else's sheet falls back to the defaults).
 */
const generalState = computed(() => {
  const state = parseGeneralSheetQuery(route.query);
  if (internal.value) return state;
  return {
    ...state,
    sort: INTERNAL_SORT_KEYS.has(state.sort.key)
      ? DEFAULT_GENERAL_SORT
      : state.sort,
    filters: {
      ...state.filters,
      view: EMPTY_GENERAL_FILTERS.view,
      observations: false,
    },
  };
});
const amendmentState = computed(() => {
  const state = parseAmendmentSheetQuery(route.query);
  if (internal.value) return state;
  const hidden =
    INTERNAL_SORT_KEYS.has(state.sort.key) ||
    (!showPositions.value && state.sort.key === "position");
  return {
    ...state,
    sort: hidden ? DEFAULT_AMENDMENT_SORT : state.sort,
    filters: {
      ...state.filters,
      view: EMPTY_AMENDMENT_FILTERS.view,
      positions: showPositions.value ? state.filters.positions : [],
    },
  };
});

/** How the presenter's answers read in «Primero» and «Filtros». */
const POSITION_LEAD_LABELS: Record<PositionLead, string> = {
  accept: "common.status.position.accept",
  transact: "common.status.position.transact",
  reject: "common.status.position.reject",
  pending: "common.status.position.pending",
  none: "controlSheet.positionNone",
};

function replaceQuery(patch: SheetQueryPatch): void {
  void router.replace({ query: { ...route.query, ...patch } });
}

function setGeneral(
  sort: SheetSort<GeneralSortKey>,
  filters: GeneralSheetFilters,
): void {
  replaceQuery(generalSheetQuery({ sort, filters }));
}

function setAmendments(
  sort: SheetSort<AmendmentSortKey>,
  filters: AmendmentSheetFilters,
): void {
  replaceQuery(amendmentSheetQuery({ sort, filters }));
}

const generalSort = computed<SheetSort<GeneralSortKey>>({
  get: () => generalState.value.sort,
  set: (sort) => setGeneral(sort, generalState.value.filters),
});
const generalView = computed<GeneralSheetFilters["view"]>({
  get: () => generalState.value.filters.view,
  set: (view) =>
    setGeneral(generalSort.value, { ...generalState.value.filters, view }),
});
const amendmentSort = computed<SheetSort<AmendmentSortKey>>({
  get: () => amendmentState.value.sort,
  set: (sort) => setAmendments(sort, amendmentState.value.filters),
});
const amendmentView = computed<AmendmentSheetFilters["view"]>({
  get: () => amendmentState.value.filters.view,
  set: (view) =>
    setAmendments(amendmentSort.value, {
      ...amendmentState.value.filters,
      view,
    }),
});

// «Filtros»: one list per thing to filter by ---------------------------------

/** Members as a filter offers them: each once, by acronym. */
function memberItems(
  members: Iterable<{ id: string; acronym: string }>,
): { value: string; label: string }[] {
  const byId = new Map<string, string>();
  for (const member of members) byId.set(member.id, member.acronym);
  return [...byId]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, locale.value));
}

const voteItems = computed(() =>
  VOTE_FILTERS.map((value) => ({
    value,
    label: t(`controlSheet.filters.votes.${value}`),
  })),
);

const generalGroups = computed<SheetFilterGroup[]>(() => {
  const filters = generalState.value.filters;
  const groups: SheetFilterGroup[] = [
    {
      key: "results",
      label: t("controlSheet.columns.result"),
      items: resultItems.value,
      selected: filters.results,
    },
    {
      key: "members",
      label: t("controlSheet.columns.proponent"),
      items: memberItems(
        generalRows.value.flatMap((row) =>
          row.documents.flatMap((document) =>
            document.proponent ? [document.proponent] : [],
          ),
        ),
      ),
      selected: filters.members,
    },
    {
      key: "votes",
      label: t("controlSheet.columns.votes"),
      items: voteItems.value,
      selected: filters.votes,
    },
  ];
  // The sheet's own notes: only whoever reads them filters by them.
  if (internal.value) {
    groups.push({
      key: "observations",
      label: t("controlSheet.columns.observations"),
      items: [
        {
          value: "with",
          label: t("controlSheet.filters.views.general.observations"),
        },
      ],
      selected: filters.observations ? ["with"] : [],
    });
  }
  return groups;
});

const amendmentGroups = computed<SheetFilterGroup[]>(() => {
  const filters = amendmentState.value.filters;
  const groups: SheetFilterGroup[] = [
    {
      key: "states",
      label: t("controlSheet.columns.result"),
      items: stateItems.value,
      selected: filters.states,
    },
    {
      key: "kinds",
      label: t("controlSheet.columns.kind"),
      items: KIND_FILTERS.map((value) => ({
        value,
        label: t(`controlSheet.kind.${value}`),
      })),
      selected: filters.kinds,
    },
    {
      key: "members",
      label: t("controlSheet.columns.authors"),
      items: memberItems(
        amendmentRows.value.flatMap((row) => row.amendment.authors),
      ),
      selected: filters.members,
    },
  ];
  if (showPositions.value) {
    groups.push({
      key: "positions",
      label: t("controlSheet.columns.position"),
      items: POSITION_LEADS.map((value) => ({
        value,
        label: t(POSITION_LEAD_LABELS[value]),
      })),
      selected: filters.positions,
    });
  }
  groups.push({
    key: "votes",
    label: t("controlSheet.columns.vote"),
    items: voteItems.value,
    selected: filters.votes,
  });
  return groups;
});

function onGeneralFilter(key: string, values: string[]): void {
  const filters = { ...generalState.value.filters };
  if (key === "results") filters.results = values as ResultFilter[];
  else if (key === "members") filters.members = values;
  else if (key === "votes") filters.votes = values as VoteFilter[];
  else if (key === "observations") filters.observations = values.length > 0;
  setGeneral(generalSort.value, filters);
}

function onAmendmentFilter(key: string, values: string[]): void {
  const filters = { ...amendmentState.value.filters };
  if (key === "states") filters.states = values as LiveAmendmentState[];
  else if (key === "kinds") filters.kinds = values as KindFilter[];
  else if (key === "members") filters.members = values;
  else if (key === "positions") filters.positions = values as PositionLead[];
  else if (key === "votes") filters.votes = values as VoteFilter[];
  setAmendments(amendmentSort.value, filters);
}

/** «Restablecer»: the default order, no filters, an empty search box. */
function resetGeneral(): void {
  searchDraft.value = "";
  setGeneral(DEFAULT_GENERAL_SORT, EMPTY_GENERAL_FILTERS);
}

function resetAmendments(): void {
  searchDraft.value = "";
  setAmendments(DEFAULT_AMENDMENT_SORT, EMPTY_AMENDMENT_FILTERS);
}

function onGeneralSort(column: GeneralSortKey): void {
  generalSort.value = nextSort(generalSort.value, column, DEFAULT_GENERAL_SORT);
}

function onAmendmentSort(column: AmendmentSortKey): void {
  amendmentSort.value = nextSort(
    amendmentSort.value,
    column,
    DEFAULT_AMENDMENT_SORT,
  );
}

/**
 * The search box: what is typed, written to the query (`q`) once typing
 * pauses. A change of the query from elsewhere (clearing, another tab, the
 * browser's back) comes back to the box, but not the one this box just
 * wrote, so nothing typed meanwhile is lost.
 */
const firstQueryValue = (value: unknown) =>
  typeof value === "string"
    ? value
    : Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : "";
const searchDraft = ref(firstQueryValue(route.query[SHEET_QUERY.search]));
const searchTyped = refDebounced(searchDraft, 300);
let searchWritten: string | null = null;
watch(searchTyped, (value) => {
  const next = value.trim();
  if (next === firstQueryValue(route.query[SHEET_QUERY.search]).trim()) return;
  searchWritten = next;
  replaceQuery({ [SHEET_QUERY.search]: next || undefined });
});
watch(
  () => firstQueryValue(route.query[SHEET_QUERY.search]).trim(),
  (value) => {
    if (value === searchWritten) {
      searchWritten = null;
      return;
    }
    if (value !== searchDraft.value.trim()) searchDraft.value = value;
  },
);

/**
 * Empties the box and forgets what it wrote: the debounce settles on ""
 * and writes nothing, and a write overtaken by the navigation that called
 * this is not waited for.
 */
function clearSearchBox(): void {
  searchDraft.value = "";
  searchWritten = null;
}

function clearGeneralFilters(): void {
  searchDraft.value = "";
  setGeneral(generalSort.value, EMPTY_GENERAL_FILTERS);
}

function clearAmendmentFilters(): void {
  searchDraft.value = "";
  setAmendments(amendmentSort.value, EMPTY_AMENDMENT_FILTERS);
}

/**
 * The rows seen under the filters in use stay until the filters change, so
 * ticking «Tratado», a result coming in or an observation cleared never
 * makes a row vanish under the reader's hand.
 */
const generalKept = shallowRef<ReadonlySet<string>>(new Set());
watch(
  [
    () => filtersKey(generalState.value.filters),
    () => matchingGeneralIds(generalRows.value, generalState.value.filters),
  ],
  ([key, matching], previous) => {
    generalKept.value = keepSeen(
      generalKept.value,
      matching,
      key !== previous?.[0],
    );
  },
  { immediate: true },
);
const amendmentKept = shallowRef<ReadonlySet<string>>(new Set());
watch(
  [
    () => filtersKey(amendmentState.value.filters),
    () =>
      matchingAmendmentIds(amendmentRows.value, amendmentState.value.filters),
  ],
  ([key, matching], previous) => {
    amendmentKept.value = keepSeen(
      amendmentKept.value,
      matching,
      key !== previous?.[0],
    );
  },
  { immediate: true },
);

/**
 * Whatever the filters, the row in debate stays («Seguir el debate» finds
 * it on the page) and so does the one whose panel is open.
 */
const generalKeep = computed(() => {
  const ids = new Set(generalKept.value);
  const liveId = live.value?.agendaItemId;
  if (liveId) ids.add(liveId);
  if (panelOpen.value && panelSubject.value?.kind === "item") {
    ids.add(panelSubject.value.id);
  }
  return ids;
});
const amendmentKeep = computed(() => {
  const ids = new Set(amendmentKept.value);
  const liveId = live.value?.amendmentId;
  if (liveId) ids.add(liveId);
  if (panelOpen.value && panelSubject.value?.kind === "amendment") {
    ids.add(panelSubject.value.id);
  }
  return ids;
});

const shownGeneral = computed(() =>
  shownGeneralRows(
    generalRows.value,
    generalState.value.sort,
    generalState.value.filters,
    generalKeep.value,
    locale.value,
  ),
);
const shownAmendments = computed(() =>
  shownAmendmentRows(
    amendmentRows.value,
    amendmentState.value.sort,
    amendmentState.value.filters,
    amendmentKeep.value,
    locale.value,
  ),
);
const generalFlat = computed(
  () => !isDefaultSort(generalState.value.sort, DEFAULT_GENERAL_SORT),
);
const generalTotal = computed(
  () => generalRows.value.filter((row) => row.kind === "item").length,
);
const generalShownCount = computed(
  () => shownGeneral.value.filter((row) => row.kind === "item").length,
);

const GENERAL_COLUMN_KEYS: Record<GeneralSortKey, string> = {
  number: "controlSheet.sort.agenda",
  item: "controlSheet.columns.item",
  proponent: "controlSheet.columns.proponent",
  treated: "controlSheet.columns.treated",
  result: "controlSheet.columns.result",
  votes: "controlSheet.columns.votes",
  speakers: "controlSheet.columns.speakers",
};
const AMENDMENT_COLUMN_KEYS: Record<AmendmentSortKey, string> = {
  treatment: "controlSheet.sort.treatment",
  code: "controlSheet.sort.presentation",
  authors: "controlSheet.columns.authors",
  kind: "controlSheet.columns.kind",
  position: "controlSheet.columns.position",
  treated: "controlSheet.columns.treated",
  result: "controlSheet.columns.result",
  vote: "controlSheet.columns.vote",
  speakers: "controlSheet.columns.speakers",
};

// The views tell rows apart by the sheet's marks: only with a sheet key.
const generalViewItems = computed(() =>
  internal.value
    ? GENERAL_VIEWS.map((value) => ({
        value,
        label: t(`controlSheet.filters.views.general.${value}`),
      }))
    : [],
);
const amendmentViewItems = computed(() =>
  internal.value
    ? AMENDMENT_VIEWS.map((value) => ({
        value,
        label: t(`controlSheet.filters.views.amendments.${value}`),
      }))
    : [],
);
const resultItems = computed(() =>
  RESULT_FILTERS.map((value) => ({
    value,
    label: t(`controlSheet.result.${value}`),
  })),
);
const stateItems = computed(() =>
  LIVE_AMENDMENT_STATES.map((value) => ({
    value,
    label: t(`liveView.state.${value}.label`),
  })),
);
const generalSortItems = computed(() =>
  GENERAL_SORT_KEYS.filter(
    (value) => internal.value || !INTERNAL_SORT_KEYS.has(value),
  ).map((value) => ({
    value,
    label: t(GENERAL_COLUMN_KEYS[value]),
  })),
);
const amendmentSortItems = computed(() =>
  AMENDMENT_SORT_KEYS.filter(
    (value) =>
      (internal.value || !INTERNAL_SORT_KEYS.has(value)) &&
      (showPositions.value || value !== "position"),
  ).map((value) => ({
    value,
    label: t(AMENDMENT_COLUMN_KEYS[value]),
  })),
);

/**
 * The states the sorted column may put first («Primero»): a result in
 * «General»; a result or the presenter's answer in «Enmiendas».
 */
const generalLeadItems = computed(() =>
  GENERAL_SORT_LEADS[generalSort.value.key] ? resultItems.value : [],
);
const amendmentLeadItems = computed(() => {
  const key = amendmentSort.value.key;
  if (!AMENDMENT_SORT_LEADS[key]) return [];
  if (key === "result") return stateItems.value;
  return POSITION_LEADS.map((value) => ({
    value,
    label: t(POSITION_LEAD_LABELS[value]),
  }));
});

const generalCount = computed(() =>
  t(
    "controlSheet.filters.count",
    { shown: generalShownCount.value, total: generalTotal.value },
    generalTotal.value,
  ),
);
const amendmentCountText = computed(() =>
  t(
    "controlSheet.filters.amendmentCount",
    { shown: shownAmendments.value.length, total: amendmentRows.value.length },
    amendmentRows.value.length,
  ),
);
const generalActive = computed(() =>
  activeFilterCount(generalState.value.filters),
);
const amendmentActive = computed(() =>
  activeFilterCount(amendmentState.value.filters),
);

/**
 * What the live region says, written only when the order or the filters
 * change (never on a refetch): «Ordenado por Resultado, ascendente · 12 de
 * 30 puntos».
 */
const listStatus = ref("");
const listStateKey = computed(() =>
  tab.value === "general"
    ? `general|${generalState.value.sort.key}|${generalState.value.sort.dir}|${generalState.value.sort.lead ?? ""}|${filtersKey(generalState.value.filters)}`
    : `amendments|${amendmentState.value.sort.key}|${amendmentState.value.sort.dir}|${amendmentState.value.sort.lead ?? ""}|${filtersKey(amendmentState.value.filters)}`,
);
watch(
  listStateKey,
  () => {
    if (tab.value !== "general" && tab.value !== "amendments") return;
    const general = tab.value === "general";
    const sort = general ? generalState.value.sort : amendmentState.value.sort;
    const column = general
      ? GENERAL_COLUMN_KEYS[sort.key as GeneralSortKey]
      : AMENDMENT_COLUMN_KEYS[sort.key as AmendmentSortKey];
    const leads = general ? generalLeadItems.value : amendmentLeadItems.value;
    const lead = sort.lead
      ? leads.find((item) => item.value === sort.lead)?.label
      : undefined;
    listStatus.value = [
      t("controlSheet.sort.status", {
        column: t(column),
        direction: t(`controlSheet.sort.${sort.dir}`),
      }),
      lead ? t("controlSheet.sort.leadStatus", { state: lead }) : null,
      general ? generalCount.value : amendmentCountText.value,
    ]
      .filter(Boolean)
      .join(" · ");
  },
  { flush: "post" },
);

// The row panel ------------------------------------------------------------------

const canEdit = computed(() => sheet.value?.can.edit ?? false);
const canModerate = computed(() => sheet.value?.can.moderate ?? false);
const panelOpen = ref(false);
/** What the panel shows, by id, so a refetch brings its row up to date. */
const panelSubject = ref<
  { kind: "item"; id: string } | { kind: "amendment"; id: string } | null
>(null);
const freshPanelTarget = computed<RowPanelTarget | null>(() => {
  const subject = panelSubject.value;
  if (!subject) return null;
  if (subject.kind === "item") {
    // Only as a row of its own: an item left as a heading is off the sheet.
    const row = generalRows.value.find(
      (entry) => entry.id === subject.id && entry.kind === "item",
    );
    return row ? { kind: "item", row } : null;
  }
  const row = amendmentRows.value.find(
    (entry) => entry.amendment.id === subject.id,
  );
  return row
    ? {
        kind: "amendment",
        row,
        code: row.amendment.code ?? t("amendment.unnumberedLabel"),
      }
    : null;
});
/**
 * The panel's row: the fresh one while the lists hold it, the last one seen
 * otherwise (following the debate to another document, a refetch on the
 * way), so the panel and what is being typed in it never vanish. An item
 * the sheet no longer holds closes its panel (below); the last row only
 * fills it while it closes.
 */
const lastPanelTarget = shallowRef<RowPanelTarget | null>(null);
watch(freshPanelTarget, (target) => {
  if (target) lastPanelTarget.value = target;
});
const panelTarget = computed<RowPanelTarget | null>(() => {
  const fresh = freshPanelTarget.value;
  if (fresh) return fresh;
  const last = lastPanelTarget.value;
  const subject = panelSubject.value;
  if (!last || !subject) return null;
  const id = last.kind === "item" ? last.row.id : last.row.amendment.id;
  return last.kind === subject.kind && id === subject.id ? last : null;
});

/**
 * Closes the panel of an item that left the sheet, saying why: the vote
 * that alone kept it there is no longer in force (`byVote`), or it went
 * some other way (taken off by hand, deleted, left as a heading).
 */
function closeLeftItemPanel(byVote: boolean): void {
  panelOpen.value = false;
  toast.add({
    title: byVote
      ? t("controlSheet.itemVotes.leftSheet")
      : t("controlSheet.panel.leftSheet"),
    icon: "i-lucide-list-x",
  });
}

// An item that leaves the sheet through someone else's write (its vote
// voided on another device, taken off by hand elsewhere, deleted) closes
// its panel once the sheet that says so has landed, rather than keep
// offering to change a row that is no longer there. Amendments keep the
// last row seen instead (following the debate to another document).
watch(
  [freshPanelTarget, () => sheetFetch.pending.value],
  ([fresh, pending]) => {
    const subject = panelSubject.value;
    if (!panelOpen.value || subject?.kind !== "item" || fresh || pending) {
      return;
    }
    const last = lastPanelTarget.value;
    closeLeftItemPanel(
      last?.kind === "item" &&
        last.row.id === subject.id &&
        last.row.itemVotes.some((vote) => vote.voidedAt === null),
    );
  },
);

function openItem(row: GeneralSheetRow): void {
  lastPanelTarget.value = { kind: "item", row };
  panelSubject.value = { kind: "item", id: row.id };
  panelOpen.value = true;
}

function openAmendment(row: AmendmentSheetRow): void {
  lastPanelTarget.value = {
    kind: "amendment",
    row,
    code: row.amendment.code ?? t("amendment.unnumberedLabel"),
  };
  panelSubject.value = { kind: "amendment", id: row.amendment.id };
  panelOpen.value = true;
}

/**
 * Puts a saved row in place at once, then fetches the sheet again with any
 * request already on its way cancelled: that one may have read the row
 * before this write, and would put the old row back when it lands (its own
 * live event only joins it).
 */
function onItemSaved(row: ControlSheetItemRowDto): void {
  const current = sheet.value;
  if (!current) return;
  sheet.value = {
    ...current,
    itemRows: [...current.itemRows.filter((entry) => entry.id !== row.id), row],
  };
  void sheetFetch.refresh({ dedupe: "cancel" });
}

/**
 * A vote on an item recorded, voided or made unanimous from the panel: in
 * place at once, then the sheet again, as onItemSaved. Null (a write
 * failed) only fetches it again. Voiding the vote that alone kept an item
 * on the sheet takes the item off it: so goes its panel, as when it is
 * taken off by hand, rather than showing the vote still in force.
 */
function onVoteChanged(vote: VoteDto | null): void {
  const current = sheet.value;
  if (vote && current) {
    sheet.value = {
      ...current,
      itemVotes: [
        ...(current.itemVotes ?? []).filter((entry) => entry.id !== vote.id),
        vote,
      ],
    };
    const subject = panelSubject.value;
    if (
      panelOpen.value &&
      subject?.kind === "item" &&
      subject.id === vote.subjectId &&
      !generalRows.value.some(
        (row) => row.id === subject.id && row.kind === "item",
      )
    ) {
      closeLeftItemPanel(true);
    }
  }
  void sheetFetch.refresh({ dedupe: "cancel" });
}

/**
 * The Mesa's latest headcount, the base of a vote on the members present
 * (undefined until it loads, null when there is none), for those who
 * record votes on items.
 */
const headcounts = useHeadcounts({
  baseUrl: apiBase,
  key: computed(() => String(route.params.assembly ?? "")),
  enabled: computed(() => canEdit.value || canModerate.value),
});
const voteContext = computed<ItemVoteContext>(() => ({
  status: assembly.value?.status ?? "draft",
  type: assembly.value?.type ?? ASSEMBLY_TYPES.AGO,
  settings: {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...(assembly.value?.settings ?? {}),
  },
  headcount: headcounts.data.value ? headcounts.latest.value : undefined,
}));

function onAmendmentSaved(row: ControlSheetAmendmentRowDto): void {
  const current = sheet.value;
  if (!current) return;
  sheet.value = {
    ...current,
    amendmentRows: [
      ...current.amendmentRows.filter((entry) => entry.id !== row.id),
      row,
    ],
  };
  void sheetFetch.refresh({ dedupe: "cancel" });
}

// Marking «Tratado» from the panel ----------------------------------------------

/**
 * The marks on their way, by item or amendment id (cuids never collide):
 * the panel's switch and the list's box show the new value at once, and a
 * second change of that row waits for the answer, so two changes never
 * send the same token and read their own write as someone else's.
 */
const treatedPending = ref<Record<string, boolean>>({});

async function saveTreated(
  kind: "item" | "amendment",
  id: string,
  control: TreatedControl,
  value: boolean,
): Promise<void> {
  if (!canModerate.value || control.lock) return;
  if (value === control.treated || id in treatedPending.value) return;
  treatedPending.value = { ...treatedPending.value, [id]: value };
  const body: ControlSheetItemBody | ControlSheetAmendmentBody = {
    treated: { value, updatedAt: control.token },
  };
  const segment = kind === "item" ? "items" : "amendments";
  const apply = (row: ControlSheetItemRowDto | ControlSheetAmendmentRowDto) =>
    kind === "item"
      ? onItemSaved(row as ControlSheetItemRowDto)
      : onAmendmentSaved(row as ControlSheetAmendmentRowDto);
  try {
    apply(
      await api.send<ControlSheetItemRowDto | ControlSheetAmendmentRowDto>(
        `${apiBase.value}/control-sheet/${segment}/${encodeURIComponent(id)}`,
        { method: "PATCH", body: { ...body } },
      ),
    );
  } catch (error) {
    const row = staleSheetRow<
      ControlSheetItemRowDto | ControlSheetAmendmentRowDto
    >(error);
    if (row) {
      apply(row);
      toast.add({
        title: t("controlSheet.panel.stale"),
        color: "warning",
        icon: "i-lucide-refresh-ccw",
      });
    } else {
      api.notifyError(error, "controlSheet.panel.saveFailed");
    }
  } finally {
    const { [id]: _done, ...rest } = treatedPending.value;
    treatedPending.value = rest;
  }
}

/** The mark on its way for the panel's row, if any. */
const panelTreatedPending = computed(() => {
  const subject = panelSubject.value;
  return subject ? treatedPending.value[subject.id] : undefined;
});

function onPanelTreated(value: boolean): void {
  const target = panelTarget.value;
  if (!target) return;
  if (target.kind === "item") {
    void saveTreated(
      "item",
      target.row.id,
      itemTreatedControl(target.row),
      value,
    );
  } else {
    void saveTreated(
      "amendment",
      target.row.amendment.id,
      amendmentTreatedControl(target.row),
      value,
    );
  }
}

// Adding an item without documents ------------------------------------------------

const addOpen = ref(false);
const addChoice = ref<string | undefined>(undefined);
const adding = ref(false);
/**
 * The items «Añadir punto» offers: those not on the sheet yet as a row of
 * their own (by their documents, by hand, or by their own vote or «Se vota
 * el punto»).
 */
const addItems = computed(() => {
  const onSheet = new Set(
    generalRows.value.filter((row) => row.kind === "item").map((row) => row.id),
  );
  return flattenAgendaTree(buildAgendaTree(items.value))
    .filter((node) => !onSheet.has(node.item.id))
    .map((node) => ({
      value: node.item.id,
      label: numberedAgendaTitle(
        node.number,
        node.item.title,
        t("agenda.unlisted.inText"),
      ),
    }));
});

async function addItem(): Promise<void> {
  const id = addChoice.value;
  if (!id || adding.value) return;
  adding.value = true;
  const current = sheet.value?.itemRows.find((row) => row.agendaItemId === id);
  try {
    const row = await api.send<ControlSheetItemRowDto>(
      `${apiBase.value}/control-sheet/items/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: {
          listed: { value: true, updatedAt: current?.listedUpdatedAt ?? null },
        },
      },
    );
    onItemSaved(row);
    addOpen.value = false;
    addChoice.value = undefined;
    toast.add({
      title: t("controlSheet.add.added"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "controlSheet.add.failed");
    refreshSheet();
  } finally {
    adding.value = false;
  }
}

/** Where the chosen document hangs in the agenda, root first. */
const selectedTrail = computed<AgendaTrailStep[]>(() =>
  selectedDocument.value
    ? documentAgendaTrail(items.value, selectedDocument.value)
    : [],
);

/**
 * "2. Posicionamientos" for an item above the document, its own number
 * alone for the document's automatic sub-item ("2.2"), which carries its
 * title.
 */
function trailLabel(step: AgendaTrailStep): string {
  const unlisted = t("agenda.unlisted.inText");
  return step.ownItem
    ? (step.number ?? unlisted)
    : numberedAgendaTitle(step.number, step.title, unlisted);
}

function documentPath(document: SheetRowDocument): string {
  return sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
}

function amendmentPath(amendment: AmendmentDto): string {
  const document = selectedDocument.value;
  if (!document) return sectionPath("documentos");
  const base = sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
  return `${base}?enmienda=${encodeURIComponent(amendment.id)}`;
}

// Live -----------------------------------------------------------------------

/** The document of the amendment in the panel: who answers it, its rule. */
/** The document of an amendment's row has its final vote. */
const panelFinalVoted = computed(() => {
  const id = panelDocument.value?.id;
  return Boolean(
    id && sheet.value?.documents.find((entry) => entry.id === id)?.finalVote,
  );
});

const panelDocument = computed(() => {
  const target = panelTarget.value;
  if (target?.kind !== "amendment") return null;
  const id = target.row.amendment.documentId;
  return agendaDocuments.value.find((document) => document.id === id) ?? null;
});

/**
 * An answer given from the panel: the sheet and the amendments again, so
 * the row, its badge and the panel show it (the sheet's own answer first,
 * newerPosition), without waiting for the live event.
 */
function onPositionSaved(): void {
  void sheetFetch.refresh({ dedupe: "cancel" });
  if (amendmentsUrl.value) void amendmentsFetch.refresh({ dedupe: "cancel" });
}

function refreshSheet(): void {
  void sheetFetch.refresh({ dedupe: "defer" });
  if (amendmentsUrl.value) void amendmentsFetch.refresh();
}

onLive((events) => {
  headcounts.onLive(events);
  if (affectsControlSheet(events)) refreshSheet();
  if (affectsLiveDebate(events)) {
    void liveFetch.refresh({ dedupe: "defer" });
  }
});

// Following the debate ----------------------------------------------------------

/**
 * On while the assembly is in session, unless the reader turns it off, or
 * opened a link that names a tab, an order or a filter (user's decision of
 * 2026-11-19): following would take it somewhere else at once.
 */
const linkNamesView = Object.keys(route.query).some(
  (key) => key === TAB_QUERY || SHEET_FILTER_QUERY_KEYS.includes(key),
);
const follow = ref(assembly.value?.status === "in_session" && !linkNamesView);

function scrollToRow(id: string): void {
  if (!import.meta.client) return;
  void nextTick(() => {
    // The table and the cards are both in the page; one of them shows.
    const row = [
      ...document.querySelectorAll<HTMLElement>(
        `[data-sheet-row="${CSS.escape(id)}"]`,
      ),
    ].find((element) => element.getClientRects().length > 0);
    if (!row) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    row.scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    });
  });
}

/**
 * Opens what the Mesa has on screen: its amendment, or its item. Never
 * from «Turnos de palabra», which lists the whole assembly and has no row
 * to follow: the debate moving on would take its reader out of it.
 */
async function followDebate(): Promise<void> {
  const state = live.value;
  if (!follow.value || !state || tab.value === "turns") return;
  if (state.amendmentId && state.documentId) {
    const document = documentOptions.value.find(
      (entry) => entry.id === state.documentId,
    );
    if (document) {
      await router.replace({
        query: {
          ...route.query,
          ...tabQuery("amendments"),
          [TAB_QUERY]: "enmiendas",
          [DOCUMENT_QUERY]: document.slug,
        },
      });
      scrollToRow(state.amendmentId);
      return;
    }
  }
  if (state.agendaItemId) {
    if (tab.value !== "general") {
      await router.replace({
        query: { ...route.query, ...tabQuery("general") },
      });
    }
    scrollToRow(state.agendaItemId);
  }
}

// Only when what is on screen moves (or following is turned on), not on
// every refetch of the live state.
watch(
  [
    () => live.value?.agendaItemId,
    () => live.value?.documentId,
    () => live.value?.amendmentId,
    follow,
  ],
  () => void followDebate(),
);
// The session opening while the sheet is open turns following on.
watch(
  () => assembly.value?.status,
  (status, previous) => {
    if (status === "in_session" && previous !== "in_session") {
      follow.value = true;
    }
  },
);
watch(
  () => amendmentRows.value.length,
  () => {
    if (follow.value && live.value?.amendmentId) {
      scrollToRow(live.value.amendmentId);
    }
  },
);
onMounted(() => void followDebate());

// Only the first load shows skeletons: refetches keep the sheet in place.
const loading = computed(
  () =>
    (sheetFetch.pending.value && !sheet.value) ||
    (agenda.pending.value && !agenda.data.value),
);
const failed = computed(() => Boolean(sheetFetch.error.value) && !sheet.value);
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <h2 class="text-highlighted text-xl font-semibold">
          {{ t("controlSheet.title") }}
        </h2>
        <p class="text-muted max-w-3xl text-sm">
          {{ t(internal ? "controlSheet.intro" : "controlSheet.introPublic") }}
        </p>
      </div>
      <USwitch
        v-model="follow"
        :label="t('controlSheet.follow')"
        :description="t('controlSheet.followHint')"
        class="max-w-xs"
      />
    </div>

    <div v-if="loading" class="space-y-3" role="status">
      <span class="sr-only">{{ t("controlSheet.loading") }}</span>
      <USkeleton
        v-for="n in 4"
        :key="n"
        aria-hidden="true"
        class="h-16 w-full"
      />
    </div>

    <UAlert
      v-else-if="failed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('controlSheet.loadError')"
      :actions="[
        {
          label: t('controlSheet.retry'),
          color: 'error',
          variant: 'outline',
          onClick: () => refreshSheet(),
        },
      ]"
      role="alert"
    />

    <template v-else>
      <UTabs
        v-model="tab"
        :items="tabItems"
        :content="false"
        variant="link"
        :aria-label="t('controlSheet.tabs.label')"
      />

      <template v-if="tab === 'general'">
        <CommonEmptyState
          v-if="generalRows.length === 0"
          icon="i-lucide-sheet"
          :title="t('controlSheet.emptyTitle')"
          :description="t('controlSheet.emptyDescription')"
          variant="outline"
        />
        <template v-else>
          <ControlSheetToolbar
            v-model:search="searchDraft"
            v-model:view="generalView"
            v-model:sort="generalSort"
            :search-label="t('controlSheet.filters.search')"
            :search-placeholder="
              t(
                internal
                  ? 'controlSheet.filters.searchGeneral'
                  : 'controlSheet.filters.searchGeneralPublic',
              )
            "
            :views="generalViewItems"
            :views-label="t('controlSheet.filters.viewsGeneral')"
            :groups="generalGroups"
            :sort-items="generalSortItems"
            :lead-items="generalLeadItems"
            :fallback="DEFAULT_GENERAL_SORT"
            :active="generalActive"
            :count="generalActive > 0 ? generalCount : null"
            :status="listStatus"
            @filter="onGeneralFilter"
            @reset="resetGeneral"
          />
          <!-- A heading in debate is shown even when no item row is. -->
          <CommonEmptyState
            v-if="shownGeneral.length === 0"
            icon="i-lucide-search-x"
            :title="t('controlSheet.filters.noMatchesTitle')"
            :description="t('controlSheet.filters.noMatchesDescription')"
            variant="outline"
          >
            <template #action>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-filter-x"
                :label="t('controlSheet.filters.clear')"
                @click="clearGeneralFilters"
              />
            </template>
          </CommonEmptyState>
          <ControlSheetGeneral
            v-else
            :rows="shownGeneral"
            :document-path="documentPath"
            :members="membersById"
            :can-edit="canEdit || canModerate"
            :treated-pending="treatedPending"
            :sort="generalSort"
            :flat="generalFlat"
            :internal="internal"
            @open="openItem"
            @sort="onGeneralSort"
          />
        </template>
        <div v-if="canEdit">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-list-plus"
            :label="t('controlSheet.add.button')"
            @click="addOpen = true"
          />
        </div>
      </template>

      <template v-else-if="tab === 'amendments'">
        <CommonEmptyState
          v-if="documentOptions.length === 0"
          icon="i-lucide-file-pen-line"
          :title="t('controlSheet.document.noneTitle')"
          :description="t('controlSheet.document.none')"
          variant="outline"
        />
        <template v-else>
          <UFormField
            :label="t('controlSheet.document.label')"
            class="max-w-3xl"
          >
            <USelectMenu
              v-model="selectedDocumentId"
              :items="selectItems"
              value-key="value"
              :search-input="{
                placeholder: t('controlSheet.document.search'),
              }"
              :ui="{
                value: 'whitespace-normal text-start',
                itemLabel: 'whitespace-normal',
              }"
              class="w-full"
            />
          </UFormField>
          <!--
              Where the document is in the agenda, and who answers its
              amendments: its main presenter.
            -->
          <dl
            v-if="selectedDocument"
            class="grid grid-cols-1 gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr] sm:items-center"
          >
            <template v-if="selectedTrail.length > 0">
              <dt class="text-muted">
                {{ t("controlSheet.documentItem") }}
              </dt>
              <dd>
                <ol class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <li
                    v-for="(step, index) in selectedTrail"
                    :key="step.id"
                    class="flex items-center gap-1.5"
                  >
                    <UIcon
                      v-if="index > 0"
                      name="i-lucide-chevron-right"
                      class="text-dimmed size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <ULink
                      :to="agendaItemPath(sectionPath(), step)"
                      class="text-default underline-offset-2 hover:underline"
                      >{{ trailLabel(step) }}</ULink
                    >
                  </li>
                </ol>
              </dd>
            </template>
            <dt class="text-muted">
              {{ t("controlSheet.documentPresenter") }}
            </dt>
            <dd class="flex flex-wrap items-center gap-2">
              <ControlSheetMemberTags
                :main="
                  selectedDocument.proponent ? [selectedDocument.proponent] : []
                "
                :others="selectedDocument.coProponents"
                :members="membersById"
                :label="t('controlSheet.documentPresenter')"
                :others-title="t('controlSheet.otherPresenters')"
              />
              <span v-if="!selectedDocument.proponent" class="text-dimmed">{{
                t("controlSheet.proponentNone")
              }}</span>
            </dd>
          </dl>
          <div
            v-if="amendmentsFetch.pending.value && !amendmentsData"
            class="space-y-3"
            role="status"
          >
            <span class="sr-only">{{ t("controlSheet.loading") }}</span>
            <USkeleton
              v-for="n in 3"
              :key="n"
              aria-hidden="true"
              class="h-14 w-full"
            />
          </div>
          <UAlert
            v-else-if="amendmentsFetch.error.value && !amendmentsData"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('controlSheet.amendmentsLoadError')"
            :actions="[
              {
                label: t('controlSheet.retry'),
                color: 'error',
                variant: 'outline',
                onClick: () => {
                  void amendmentsFetch.refresh();
                },
              },
            ]"
            role="alert"
          />
          <p v-else-if="amendmentRows.length === 0" class="text-muted text-sm">
            {{ t("controlSheet.amendmentsEmpty") }}
          </p>
          <template v-else>
            <ControlSheetToolbar
              v-model:search="searchDraft"
              v-model:view="amendmentView"
              v-model:sort="amendmentSort"
              :search-label="t('controlSheet.filters.search')"
              :search-placeholder="t('controlSheet.filters.searchAmendments')"
              :views="amendmentViewItems"
              :views-label="t('controlSheet.filters.viewsAmendments')"
              :groups="amendmentGroups"
              :sort-items="amendmentSortItems"
              :lead-items="amendmentLeadItems"
              :fallback="DEFAULT_AMENDMENT_SORT"
              :active="amendmentActive"
              :count="amendmentActive > 0 ? amendmentCountText : null"
              :status="listStatus"
              @filter="onAmendmentFilter"
              @reset="resetAmendments"
            />
            <CommonEmptyState
              v-if="shownAmendments.length === 0"
              icon="i-lucide-search-x"
              :title="t('controlSheet.filters.noMatchesAmendments')"
              :description="t('controlSheet.filters.noMatchesDescription')"
              variant="outline"
            >
              <template #action>
                <UButton
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-filter-x"
                  :label="t('controlSheet.filters.clear')"
                  @click="clearAmendmentFilters"
                />
              </template>
            </CommonEmptyState>
            <ControlSheetAmendments
              v-else
              :rows="shownAmendments"
              :amendment-path="amendmentPath"
              :members="membersById"
              :can-edit="canEdit || canModerate"
              :treated-pending="treatedPending"
              :sort="amendmentSort"
              :internal="internal"
              :show-positions="showPositions"
              @open="openAmendment"
              @sort="onAmendmentSort"
            />
          </template>
        </template>
      </template>

      <ControlSheetTurns
        v-else-if="tab === 'turns'"
        :turns="sheet?.turns ?? []"
        :items="items"
      />

      <!-- Its first page loads with it (async setup): a skeleton meanwhile. -->
      <Suspense v-else>
        <ControlSheetHistory
          :api-base="apiBase"
          :items="items"
          :documents="agendaDocuments"
        />
        <template #fallback>
          <div class="space-y-3" role="status">
            <span class="sr-only">{{ t("controlSheet.loading") }}</span>
            <USkeleton
              v-for="n in 4"
              :key="n"
              aria-hidden="true"
              class="h-12 w-full"
            />
          </div>
        </template>
      </Suspense>
    </template>

    <ControlSheetRowPanel
      v-model:open="panelOpen"
      :target="panelTarget"
      :api-base="apiBase"
      :can="{ internal, edit: canEdit, moderate: canModerate }"
      :treated-pending="panelTreatedPending"
      :vote-context="voteContext"
      :document="panelDocument"
      :speaker-turns="sheet?.turns ?? []"
      :speakers="{ note: canNoteSpeakers, open: speakerNotesOpen }"
      :results="{
        record: canRecordResults,
        amendments: amendmentsData?.amendments ?? [],
        finalVoted: panelFinalVoted,
      }"
      @item-saved="onItemSaved"
      @amendment-saved="onAmendmentSaved"
      @treated="onPanelTreated"
      @vote-changed="onVoteChanged"
      @position-saved="onPositionSaved"
      @speakers-updated="refreshSheet"
      @result-changed="onPositionSaved"
    />

    <UModal
      v-model:open="addOpen"
      :title="t('controlSheet.add.title')"
      :description="t('controlSheet.add.description')"
    >
      <template #body>
        <p v-if="addItems.length === 0" class="text-muted text-sm">
          {{ t("controlSheet.add.none") }}
        </p>
        <UFormField v-else :label="t('controlSheet.add.label')">
          <USelectMenu
            v-model="addChoice"
            :items="addItems"
            value-key="value"
            :placeholder="t('controlSheet.add.placeholder')"
            class="w-full"
          />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="addOpen = false"
          />
          <UButton
            icon="i-lucide-list-plus"
            :label="t('controlSheet.add.confirm')"
            :loading="adding"
            :disabled="!addChoice"
            @click="addItem"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import type { TabsItem } from "@nuxt/ui";
import { ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AmendmentDto,
  AmendmentOutcomeDto,
  ControlSheetAmendmentBody,
  ControlSheetAmendmentRowDto,
  ControlSheetDto,
  ControlSheetItemBody,
  ControlSheetItemRowDto,
  ControlSheetNotesDto,
  DocumentAmendmentsDto,
  DocumentDto,
  LiveEventDto,
  LiveStateDto,
  MemberDto,
  SpeakingTurnDto,
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
  affectsSheetAmendments,
  affectsSheetPreview,
  amendedDocuments,
  amendmentTreatedControl,
  buildAmendmentRows,
  buildGeneralRows,
  documentAgendaTrail,
  followWaitsForPanel,
  itemTreatedControl,
  previewAmendmentRows,
  sheetTurnsFromNotes,
  staleSheetRow,
  type AgendaTrailStep,
  type AmendmentSheetRow,
  type GeneralSheetRow,
  type ItemVoteContext,
  type SheetRowDocument,
  type TreatedControl,
} from "~/components/control-sheet/-model";
import {
  awaitsPresenterAnswer,
  indexOwnNotes,
} from "~/components/control-sheet/-readers";
import {
  LIVE_AMENDMENT_STATES,
  type LiveAmendmentState,
} from "~/components/live-view/-model";
import type { SheetFilterGroup } from "~/components/control-sheet/Toolbar.vue";
import type { PackagePreset } from "~/components/export/-packageFilters";
import { agendaItemPath } from "~/composables/document/agendaReturn";
import { provideAmendmentLinks } from "~/composables/amendment/amendmentLinks";
import type { RowPanelTarget } from "~/components/control-sheet/RowPanel.vue";
import { numberedAgendaTitle } from "~/utils/agendaTree";
import { positionsArePublic } from "~~/shared/utils/positions";
import {
  debateMoved,
  firstRowInView,
  readSheetReturn,
  scrollTopForAnchor,
  withSheetReturn,
  type SheetReturnState,
  type SheetReturnTab,
} from "~/components/control-sheet/-return";
import { scrollParentOf } from "~/utils/scrollAnchor";
import { holdEarlyLive } from "~/composables/assembly/-liveWiring";
import { followLiveState } from "~/composables/live/-liveState";

/**
 * The control sheet of the assembly (hoja de control), for the Mesa, the
 * CEA, the Secretaría and the Presidencia (control_sheet:view or :edit):
 * «General», one row per agenda item with documents, and «Enmiendas», the
 * amendments of one document. It replaces the spreadsheet they kept during
 * the session and feeds the minutes (docs/control-sheet-plan.md).
 *
 * Everyone else who sees the assembly reads it too (user's decision of
 * 2026-11-19), only what is public (ControlSheetDto.can.internal false):
 * «General» and «Enmiendas» with whether each row was treated (its chips
 * and its order too) but without who spoke and the observations, the
 * presenter's answers once public, and neither «Turnos de palabra» nor
 * «Historial».
 *
 * The agenda comes from the hub (useAssemblyAgenda); the sheet's own answer
 * adds the final votes, the votes on items, the amendment counts and who
 * spoke. «Seguir el debate» opens what the Mesa has on screen and marks its
 * row; in «Enmiendas», the amendments of the document in debate. Each list
 * sorts by its columns and filters (-filters.ts), both kept in the query
 * next to the tab and the document. The tabs stay at hand while scrolling,
 * and «General» opens a document's amendments in «Enmiendas». Every
 * document and amendment opens in a floating window too («Vista previa»),
 * and coming back to the sheet (Back) finds it as it was left (-return.ts).
 */

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const route = useRoute();
const router = useRouter();
const { can } = useMe();
const {
  assembly,
  apiBase,
  sectionPath,
  onLive,
  onLiveState,
  live: liveStream,
} = useCurrentAssembly();

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

/**
 * The live state in order (`updatedAt`): pushed on the stream after each
 * move of the Mesa (onLiveState), read on a poll, a reconnection or when
 * no push covered a batch.
 */
const liveFollower = followLiveState({
  apply: (state) => {
    liveFetch.data.value = state;
  },
});
onScopeDispose(liveFollower.dispose);
const liveFetch = useFetch<LiveStateDto>(() => `${apiBase.value}/live-state`, {
  key: computed(() => `control-sheet-live-${assembly.value?.id ?? "none"}`),
  dedupe: "defer",
  // A push that overtook the read stays.
  transform: (state: LiveStateDto) => liveFollower.fetched(state) ?? state,
});

const agenda = useAssemblyAgenda();
// The page's live handler is registered far below, after this await; a
// batch that arrives meanwhile is held and handed to it then
// (holdEarlyLive), or the sheet would miss it until the next event. The
// agenda follows the stream on its own (useAssemblyAgenda).
const registerLive = holdEarlyLive(onLive);
await Promise.all([sheetFetch, liveFetch, agenda]);
// What the page holds is the state to beat; a push that came while the
// page loaded is handed over now, and kept only if newer than that read
// (`replay`).
liveFollower.fetched(liveFetch.data.value ?? null);
onLiveState(liveFollower.pushed);

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

/**
 * «Seguir el debate»: on while the assembly is in session, unless the
 * reader turns it off, or opened a link that names a tab, an order or a
 * filter (user's decision of 2026-11-19): following would take it
 * somewhere else at once.
 */
const linkNamesView = Object.keys(route.query).some(
  (key) => key === TAB_QUERY || SHEET_FILTER_QUERY_KEYS.includes(key),
);
const follow = ref(assembly.value?.status === "in_session" && !linkNamesView);

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
    // Following the debate, «Enmiendas» opens on the document in debate.
    const debated =
      value === "amendments" && follow.value ? debateDocument.value : null;
    void router.replace({
      query: {
        ...route.query,
        ...tabQuery(value),
        ...(debated ? { [DOCUMENT_QUERY]: debated.slug } : {}),
      },
    });
    scrollToTabs();
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
/** The amendments «Enmiendas» lists of each document, for «General». */
const amendmentCounts = computed<ReadonlyMap<string, number>>(
  () =>
    new Map(
      documentOptions.value.map((document) => [
        document.id,
        document.amendments,
      ]),
    ),
);
/**
 * The document in debate, among those with amendments the reader sees:
 * the one the Mesa has on screen, or else the first of the item in debate
 * (user's decision of 2026-11-19).
 */
const debateDocument = computed(() => {
  const state = live.value;
  if (!state) return null;
  const onScreen = state.documentId
    ? documentOptions.value.find((entry) => entry.id === state.documentId)
    : undefined;
  if (onScreen) return onScreen;
  return state.agendaItemId
    ? (documentOptions.value.find(
        (entry) => entry.agendaItemId === state.agendaItemId,
      ) ?? null)
    : null;
});
/**
 * The document of the amendment whose panel is open (null with none open):
 * following the debate leaves it shown until the panel closes
 * (followWaitsForPanel), so the panel's row stays in the list.
 */
const amendmentPanelDocumentId = ref<string | null>(null);
const selectedDocument = computed(() => {
  const wanted = route.query[DOCUMENT_QUERY];
  const byId = (id: string | null) =>
    id ? documentOptions.value.find((document) => document.id === id) : null;
  return (
    documentOptions.value.find(
      (document) => document.slug === wanted || document.id === wanted,
    ) ??
    byId(amendmentPanelDocumentId.value) ??
    (follow.value ? debateDocument.value : null) ??
    documentOptions.value[0] ??
    null
  );
});
const selectItems = computed(() =>
  documentOptions.value.map((document) => ({
    value: document.id,
    label: document.title,
    description: [
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
      // What waits for the reader's answer, on a document it presents.
      document.presenting && document.awaitingAnswer > 0
        ? t(
            "controlSheet.answer.awaiting",
            { count: document.awaitingAnswer },
            document.awaitingAnswer,
          )
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  })),
);
const selectedDocumentId = computed<string | undefined>({
  get: () => selectedDocument.value?.id,
  set: (id) => {
    const document = documentOptions.value.find((entry) => entry.id === id);
    if (!document) return;
    leaveDebateFor(document.id);
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

// Codes of other amendments in the notes open them in the preview window,
// the page's only preview (user's decisions of 2026-11-20).
provideAmendmentLinks({
  inWindow: true,
  get: (id) =>
    amendmentsData.value?.amendments.find((amendment) => amendment.id === id),
  baseOf: () => null,
  open: (id) => {
    const amendment = amendmentsData.value?.amendments.find(
      (item) => item.id === id,
    );
    if (!amendment) return;
    previewDocumentId.value = null;
    previewAmendment.value = {
      documentId: amendment.documentId,
      amendmentId: amendment.id,
    };
  },
});

const generalRows = computed(() =>
  buildGeneralRows(
    items.value,
    agendaDocuments.value,
    sheet.value ?? null,
    live.value?.agendaItemId ?? null,
  ),
);
/**
 * The reader presents the chosen document (ControlSheetDocumentDto
 * .presenting): what waits for its answer is marked (awaitsAnswer).
 */
const presentingSelected = computed(
  () => selectedDocument.value?.presenting ?? false,
);
/** The reader presents a document of the sheet: «Mis documentos». */
const presentsAny = computed(
  () => sheet.value?.documents.some((document) => document.presenting) ?? false,
);
const amendmentRows = computed(() => {
  const rows = buildAmendmentRows(
    amendmentsData.value?.amendments ?? [],
    sheet.value?.sessionStartedAt ?? null,
    live.value?.amendmentId ?? null,
    sheet.value?.amendmentRows ?? [],
    sheet.value?.positions ?? [],
    sheet.value?.turns ?? [],
    // The console's order, by answer whether public or not yet.
    { byAnswer: true },
    new Set(sheet.value?.treated?.amendmentIds ?? []),
  );
  if (!presentingSelected.value) return rows;
  return rows.map((row) => ({
    ...row,
    awaitsAnswer: awaitsPresenterAnswer(row, true),
  }));
});

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

/**
 * Sort keys a reader without a sheet key has no column for. «Tratado» is
 * everyone's (user's decision of 2026-11-19).
 */
const INTERNAL_SORT_KEYS: ReadonlySet<string> = new Set(["speakers"]);

/**
 * The state in the query as this reader may use it: without a sheet key,
 * no filter by observations and no sort by a column it does not have (a
 * link from someone else's sheet falls back to the defaults).
 */
const generalState = computed(() => {
  const parsed = parseGeneralSheetQuery(route.query);
  // «Mis documentos» only for whoever presents one.
  const state = presentsAny.value
    ? parsed
    : { ...parsed, filters: { ...parsed.filters, mine: false } };
  if (internal.value) return state;
  return {
    ...state,
    sort: INTERNAL_SORT_KEYS.has(state.sort.key)
      ? DEFAULT_GENERAL_SORT
      : state.sort,
    filters: { ...state.filters, observations: false },
  };
});
const amendmentState = computed(() => {
  const parsed = parseAmendmentSheetQuery(route.query);
  // «Por responder» only on a document the reader presents.
  const state = presentingSelected.value
    ? parsed
    : { ...parsed, filters: { ...parsed.filters, mine: false } };
  if (internal.value) return state;
  const hidden =
    INTERNAL_SORT_KEYS.has(state.sort.key) ||
    (!showPositions.value && state.sort.key === "position");
  return {
    ...state,
    sort: hidden ? DEFAULT_AMENDMENT_SORT : state.sort,
    filters: {
      ...state.filters,
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
  // «Mis documentos» (user's decision of 2026-11-21).
  if (presentsAny.value) {
    groups.push({
      key: "mine",
      label: t("controlSheet.filters.mine.general.label"),
      items: [
        { value: "mine", label: t("controlSheet.filters.mine.general.item") },
      ],
      selected: filters.mine ? ["mine"] : [],
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
  // «Por responder»: what waits for the reader's answer as its presenter.
  if (presentingSelected.value) {
    groups.push({
      key: "mine",
      label: t("controlSheet.filters.mine.amendments.label"),
      items: [
        {
          value: "mine",
          label: t("controlSheet.filters.mine.amendments.item"),
        },
      ],
      selected: filters.mine ? ["mine"] : [],
    });
  }
  return groups;
});

function onGeneralFilter(key: string, values: string[]): void {
  const filters = { ...generalState.value.filters };
  if (key === "results") filters.results = values as ResultFilter[];
  else if (key === "members") filters.members = values;
  else if (key === "votes") filters.votes = values as VoteFilter[];
  else if (key === "observations") filters.observations = values.length > 0;
  else if (key === "mine") filters.mine = values.length > 0;
  setGeneral(generalSort.value, filters);
}

function onAmendmentFilter(key: string, values: string[]): void {
  const filters = { ...amendmentState.value.filters };
  if (key === "states") filters.states = values as LiveAmendmentState[];
  else if (key === "kinds") filters.kinds = values as KindFilter[];
  else if (key === "members") filters.members = values;
  else if (key === "positions") filters.positions = values as PositionLead[];
  else if (key === "votes") filters.votes = values as VoteFilter[];
  else if (key === "mine") filters.mine = values.length > 0;
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

// The download of what a list shows -------------------------------------------------

/**
 * «Descargar» beside each list's filters (user's decision of 2026-11-20):
 * the documentation package of what the list shows as it stands, filters,
 * search and kept rows included. «General» gives the published documents
 * of its rows, with their texts and amendments; «Enmiendas» the amendments
 * it shows, without the text (ExportPackageDialog says how many of them are
 * not published, which never go). The dialog's own filters are at hand.
 */
const packageOpen = ref(false);
const packagePreset = ref<PackagePreset | null>(null);
const generalPackageDocuments = computed(() =>
  shownGeneral.value.flatMap((row) =>
    row.kind === "item"
      ? row.documents
          .filter((document) => document.status === "published")
          .map((document) => document.id)
      : [],
  ),
);
function openGeneralPackage(): void {
  packagePreset.value = { documentIds: generalPackageDocuments.value };
  packageOpen.value = true;
}
function openAmendmentsPackage(): void {
  const document = selectedDocument.value;
  if (!document) return;
  packagePreset.value = {
    documentIds: [document.id],
    texts: false,
    amendmentIds: shownAmendments.value.map((row) => row.amendment.id),
  };
  packageOpen.value = true;
}
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
  document: "controlSheet.sort.document",
  code: "controlSheet.sort.presentation",
  authors: "controlSheet.columns.authors",
  kind: "controlSheet.columns.kind",
  position: "controlSheet.columns.position",
  treated: "controlSheet.columns.treated",
  result: "controlSheet.columns.result",
  vote: "controlSheet.columns.vote",
  speakers: "controlSheet.columns.speakers",
};

// «Todos / Pendientes / Tratados»: whether each row was treated is every
// reader's (ControlSheetDto.treated).
const generalViewItems = computed(() =>
  GENERAL_VIEWS.map((value) => ({
    value,
    label: t(`controlSheet.filters.views.general.${value}`),
  })),
);
const amendmentViewItems = computed(() =>
  AMENDMENT_VIEWS.map((value) => ({
    value,
    label: t(`controlSheet.filters.views.amendments.${value}`),
  })),
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

/**
 * «Mis notas» (user's decision of 2026-11-21): every reader without the
 * sheet's key to edit gets a column with its own general private notes on
 * each document and amendment, read through their own endpoint (never part
 * of the sheet's answer, refetched on every live batch), and writes them in
 * the row's panel. Notes send no live event: they are read again
 * when the window comes back to the front, when the panel closes and after
 * a note is written there.
 */
const showOwnNotes = computed(() => Boolean(sheet.value) && !canEdit.value);
const ownNotesFetch = useAsyncData<ControlSheetNotesDto | null>(
  computed(
    () =>
      `control-sheet-notes:${showOwnNotes.value ? (assembly.value?.id ?? "none") : "none"}`,
  ),
  () =>
    showOwnNotes.value
      ? api.get<ControlSheetNotesDto>(`${apiBase.value}/control-sheet/notes`)
      : Promise.resolve(null),
  { default: () => null, lazy: true, server: false },
);
const ownNotes = computed(() =>
  showOwnNotes.value ? indexOwnNotes(ownNotesFetch.data.value) : null,
);
function refreshOwnNotes(): void {
  if (showOwnNotes.value) void ownNotesFetch.refresh();
}
if (import.meta.client) useEventListener(window, "focus", refreshOwnNotes);
/** What the row's panel needs for «Mis notas». */
const panelOwnNotes = computed(() =>
  showOwnNotes.value
    ? {
        documentPath: (slug: string) =>
          sectionPath(`documentos/${encodeURIComponent(slug)}`),
      }
    : null,
);
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
 * otherwise (the reader choosing another document, a refetch on the way;
 * following the debate waits for an amendment's panel to close), so the
 * panel and what is being typed in it never vanish. An item
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
  amendmentPanelDocumentId.value = null;
  panelOpen.value = true;
}

function openAmendment(row: AmendmentSheetRow): void {
  lastPanelTarget.value = {
    kind: "amendment",
    row,
    code: row.amendment.code ?? t("amendment.unnumberedLabel"),
  };
  panelSubject.value = { kind: "amendment", id: row.amendment.id };
  amendmentPanelDocumentId.value = row.amendment.documentId;
  panelOpen.value = true;
}

/**
 * The panel's notice of observations that could not be saved opens their
 * row again: the row as the lists hold it now, else as it was last seen;
 * an amendment of another document shows that document's amendments, so
 * its row is a live one. The document shown is read before the panel opens:
 * opening it makes its own document the shown one (amendmentPanelDocumentId)
 * while the query names none.
 */
function reopenPanel(target: RowPanelTarget): void {
  if (target.kind === "item") {
    openItem(target.row);
    return;
  }
  const shownDocumentId = selectedDocument.value?.id;
  openAmendment(target.row);
  const documentId = target.row.amendment.documentId;
  const document = documentOptions.value.find(
    (entry) => entry.id === documentId,
  );
  if (document && shownDocumentId !== documentId) {
    leaveDebateFor(documentId);
    void router.replace({
      query: {
        ...route.query,
        ...tabQuery("amendments"),
        [TAB_QUERY]: "enmiendas",
        [DOCUMENT_QUERY]: document.slug,
      },
    });
  }
}

/** Following the debate waited for the amendment's panel to close. */
let followWaiting = false;
watch(panelOpen, (open) => {
  if (open) return;
  amendmentPanelDocumentId.value = null;
  // A note on the amendment may have been written in the panel.
  refreshOwnNotes();
  if (followWaiting) {
    followWaiting = false;
    void followDebate();
  }
});

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

/** «N enmiendas» of a document in «General»: its amendments here. */
function openDocumentAmendments(document: SheetRowDocument): void {
  const option = documentOptions.value.find(
    (entry) => entry.id === document.id,
  );
  if (!option) return;
  leaveDebateFor(option.id);
  void router.replace({
    query: {
      ...route.query,
      ...tabQuery("amendments"),
      [DOCUMENT_QUERY]: option.slug,
    },
  });
  scrollToTabs();
}

/**
 * The tabs stick to the top while the page scrolls (user's decision of
 * 2026-11-19). Changing tab from there brings the page back to its top,
 * not to wherever the last tab was left; with the tabs in their place it
 * stays put. `tabsAnchor` is the heading just above them.
 */
const tabsAnchor = ref<HTMLElement | null>(null);
const tabsBar = ref<HTMLElement | null>(null);
function scrollToTabs(): void {
  if (!import.meta.client) return;
  void nextTick(() => {
    const anchor = tabsAnchor.value;
    const bar = tabsBar.value;
    if (!anchor || !bar) return;
    // In their place they sit one gap (1.5rem) under the heading.
    const gap =
      bar.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom;
    if (gap <= 25) return;
    anchor.scrollIntoView({ block: "start" });
  });
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

// The floating preview -------------------------------------------------------

/**
 * «Vista previa» (user's decision of 2026-11-19): a document or an amendment
 * read in the live view's floating windows without leaving the sheet. Kept
 * by its own ids, never by the selected document, which following the
 * debate may switch while it is open; its full DocumentDto is fetched only
 * while one is open.
 */
const previewDocumentId = ref<string | null>(null);
const previewAmendment = ref<{
  documentId: string;
  amendmentId: string;
} | null>(null);
const previewFetchId = computed(
  () => previewAmendment.value?.documentId ?? previewDocumentId.value,
);
const previewFetch = useAsyncData<DocumentDto | null>(
  computed(() => `control-sheet-preview:${previewFetchId.value ?? "none"}`),
  () => {
    const id = previewFetchId.value;
    return id
      ? api.get<DocumentDto>(
          `${apiBase.value}/documents/${encodeURIComponent(id)}`,
        )
      : Promise.resolve(null);
  },
  { default: () => null, lazy: true, server: false },
);
const { data: keptPreview } = keepLastGoodData(previewFetch, {
  resetOn: previewFetchId,
});
const previewDocument = onlyForKey(
  keptPreview,
  () => previewFetchId.value,
  (value) => value.id,
);
/**
 * The document asked for could not be loaded (a 404 too: hidden or
 * withdrawn meanwhile), and nothing of it is kept to show.
 */
const previewFailed = computed(
  () =>
    previewFetchId.value !== null &&
    !previewDocument.value &&
    previewFetch.status.value === "error",
);
/** One is open and its document is not here yet, nor failed. */
const previewLoading = computed(
  () =>
    previewFetchId.value !== null &&
    !previewDocument.value &&
    !previewFailed.value,
);

const previewDocumentOpen = computed({
  get: () => previewDocumentId.value !== null,
  set: (value) => {
    if (!value) previewDocumentId.value = null;
  },
});
const previewDocumentPath = computed(() => {
  const id = previewFetchId.value;
  const summary = id
    ? agendaDocuments.value.find((entry) => entry.id === id)
    : undefined;
  return summary
    ? sectionPath(`documentos/${encodeURIComponent(summary.slug)}`)
    : null;
});

function openDocumentPreview(document: { id: string }): void {
  previewAmendment.value = null;
  previewDocumentId.value = document.id;
}

function openAmendmentPreview(row: AmendmentSheetRow): void {
  previewDocumentId.value = null;
  previewAmendment.value = {
    documentId: row.amendment.documentId,
    amendmentId: row.amendment.id,
  };
}

/** The amendment shown; the window closes when its row leaves the list. */
const previewAmendmentId = computed<string | null>({
  get: () => previewAmendment.value?.amendmentId ?? null,
  set: (id) => {
    const current = previewAmendment.value;
    previewAmendment.value =
      id && current ? { ...current, amendmentId: id } : null;
  },
});
/** Paged as the list shows them; their notes read every amendment. */
const previewRows = computed(() => previewAmendmentRows(shownAmendments.value));
// The window's rows are the selected document's: following the debate (or
// the selector) onto another document, or its row leaving the list (a
// filter, a deleted amendment), hides it, which never runs its `update:open`.
// Forget it then, so it neither keeps fetching its document nor opens again
// by itself when the row comes back.
watch(
  () => selectedDocument.value?.id,
  (id) => {
    const current = previewAmendment.value;
    if (current && current.documentId !== id) previewAmendment.value = null;
  },
);
watch(previewRows, (rows) => {
  const current = previewAmendment.value;
  // Only over the document's own amendments, loaded: never the empty list
  // while another document's load.
  if (
    !current ||
    amendmentsData.value?.documentId !== current.documentId ||
    rows.some((row) => row.amendment.id === current.amendmentId)
  ) {
    return;
  }
  previewAmendment.value = null;
});
const previewNoteRows = computed(() =>
  previewAmendmentRows(amendmentRows.value),
);

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
 * An amendment as a write from the panel answered it, in its document's
 * list at once (only that document's list holds it).
 */
function putAmendment(updated: AmendmentDto): void {
  const current = keptAmendments.value;
  if (!current || current.documentId !== updated.documentId) return;
  keptAmendments.value = {
    ...current,
    amendments: current.amendments.map((amendment) =>
      amendment.id === updated.id ? updated : amendment,
    ),
  };
}

/** The sheet and the amendments again, with any fetch on its way cancelled. */
function refetchAfterPanelWrite(): void {
  void sheetFetch.refresh({ dedupe: "cancel" });
  if (amendmentsUrl.value) void amendmentsFetch.refresh({ dedupe: "cancel" });
}

/**
 * An answer given from the panel: in place at once, in the amendment and in
 * the sheet's own answers (the row shows the sheet's first, newerPosition),
 * so the row, its badge and the panel show it, and the panel's choice reads
 * as saved; then the sheet and the amendments again, as onItemSaved. Never
 * joined to a fetch on its way: it may have read before the write.
 */
function onPositionSaved(updated: AmendmentDto): void {
  putAmendment(updated);
  const current = sheet.value;
  const position = updated.position;
  if (current && position) {
    sheet.value = {
      ...current,
      positions: [
        ...current.positions.filter(
          (entry) => entry.amendmentId !== updated.id,
        ),
        { amendmentId: updated.id, position },
      ],
    };
  }
  refetchAfterPanelWrite();
}

/**
 * A result recorded or annulled from the panel: the amendment in place at
 * once (its buttons follow it), then the sheet and the amendments again
 * (a vote or a reopening may change others). Null (a final vote, a write
 * that failed) only fetches them again.
 */
function onResultChanged(outcome: AmendmentOutcomeDto | null): void {
  if (outcome) putAmendment(outcome.amendment);
  refetchAfterPanelWrite();
}

/**
 * A live event: the sheet again. A fetch already on its way may have read
 * before the change the event announces, so it is never joined: one this
 * refresh started is waited for and run once more (trailingRefresh),
 * however many events come meanwhile, and any other (a write's) is
 * replaced (`dedupe: "cancel"`, which cannot starve: the runs follow one
 * another).
 */
const refreshSheetTrailing = trailingRefresh(() =>
  sheetFetch.refresh({ dedupe: "cancel" }),
);
const refreshAmendmentsTrailing = trailingRefresh(() =>
  amendmentsUrl.value
    ? amendmentsFetch.refresh({ dedupe: "cancel" })
    : Promise.resolve(),
);
const refreshPreviewTrailing = trailingRefresh(() =>
  previewFetchId.value
    ? previewFetch.refresh({ dedupe: "cancel" })
    : Promise.resolve(),
);
/**
 * The sheet again, after `events` (none: a write of the page, or the
 * reader asking): the chosen document's amendments too, the same way, when
 * the events may change them (affectsSheetAmendments: never the speakers,
 * the seating, the sheet's notes nor another document); an open preview
 * reads its document again too (its text, its amendments' answers), only
 * while one is open and when the events may change it (affectsSheetPreview).
 */
function refreshSheet(events?: readonly LiveEventDto[]): void {
  void refreshSheetTrailing();
  if (
    amendmentsUrl.value &&
    (!events || affectsSheetAmendments(events, selectedDocument.value?.id))
  ) {
    void refreshAmendmentsTrailing();
  }
  if (previewFetchId.value && (!events || affectsSheetPreview(events))) {
    void refreshPreviewTrailing();
  }
}

/**
 * Someone noted as having spoken, or taken back, from the panel: the
 * notes' answer (every turn that spoke) goes in at once, filtered as the
 * sheet filters it, so the panel's chips and the column show it in the same
 * tick; then the sheet again, with any fetch on its way cancelled.
 */
function onSpeakersUpdated(turns: SpeakingTurnDto[]): void {
  const current = sheet.value;
  if (current) {
    sheet.value = {
      ...current,
      turns: sheetTurnsFromNotes(
        turns,
        new Set(items.value.map((item) => item.id)),
      ),
    };
  }
  void sheetFetch.refresh({ dedupe: "cancel" });
}

/** The live state again, the same way as the sheet (never joined). */
const refreshLiveTrailing = trailingRefresh(() =>
  liveFetch.refresh({ dedupe: "cancel" }),
);

// With any batch that came while the page loaded (registerLive).
registerLive((events) => {
  headcounts.onLive(events);
  if (affectsControlSheet(events)) refreshSheet(events);
  // A move of the Mesa came pushed (onLiveState) unless no push covered it.
  if (
    affectsLiveDebate(events) &&
    (events.some((event) => event.type === "poll") || !liveStream.statePushed())
  ) {
    void refreshLiveTrailing();
  }
});

// Following the debate ----------------------------------------------------------

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
 * Opens what the Mesa has on screen: its amendment, or its item; in
 * «Enmiendas», the amendments of the document in debate if it has any the
 * reader sees. Never from «Turnos de palabra», which lists the whole
 * assembly and has no row to follow: the debate moving on would take its
 * reader out of it. Whether it went anywhere: false when there was nothing
 * to follow (nothing on screen, «Turnos de palabra», the document already
 * shown) or it waits: while an amendment's panel is open, another document
 * waits until it closes (followWaitsForPanel), so the panel never stays on
 * a row the list no longer holds.
 */
async function followDebate(): Promise<boolean> {
  const state = live.value;
  if (!follow.value || !state || tab.value === "turns") return false;
  // Coming back where the reader left it: the sheet stays there.
  if (holdFollow) return false;
  const waitsForPanel = (documentId: string) => {
    const waits = followWaitsForPanel(
      { open: panelOpen.value, kind: panelSubject.value?.kind ?? null },
      amendmentPanelDocumentId.value,
      documentId,
    );
    if (waits) followWaiting = true;
    return waits;
  };
  if (state.amendmentId && state.documentId) {
    const document = documentOptions.value.find(
      (entry) => entry.id === state.documentId,
    );
    if (document) {
      if (waitsForPanel(document.id)) return false;
      await router.replace({
        query: {
          ...route.query,
          ...tabQuery("amendments"),
          [TAB_QUERY]: "enmiendas",
          [DOCUMENT_QUERY]: document.slug,
        },
      });
      scrollToRow(state.amendmentId);
      return true;
    }
  }
  const debated = debateDocument.value;
  if (tab.value === "amendments" && debated) {
    if (selectedDocument.value?.id === debated.id) return false;
    if (waitsForPanel(debated.id)) return false;
    await router.replace({
      query: { ...route.query, [DOCUMENT_QUERY]: debated.slug },
    });
    return true;
  }
  if (state.agendaItemId) {
    if (tab.value !== "general") {
      await router.replace({
        query: { ...route.query, ...tabQuery("general") },
      });
    }
    scrollToRow(state.agendaItemId);
    return true;
  }
  return false;
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
    if (holdFollow) return;
    if (follow.value && live.value?.amendmentId) {
      scrollToRow(live.value.amendmentId);
    }
  },
);

/**
 * Following stops once the reader leaves what is in debate (user's decision
 * of 2026-11-20): opening another document's amendments, or scrolling the
 * row in debate out of view. Moving between «General» and «Enmiendas» on
 * the same document does not count; the button takes it back.
 */
function leaveDebateFor(documentId: string): void {
  if (follow.value && debateDocument.value?.id !== documentId) {
    follow.value = false;
  }
}

/** The row in debate as the list on show has it, if it is in the page. */
function debatedRow(): HTMLElement | null {
  const state = live.value;
  if (!state || !import.meta.client) return null;
  const id =
    tab.value === "amendments"
      ? (state.amendmentId ?? null)
      : tab.value === "general"
        ? state.agendaItemId
        : null;
  if (!id) return null;
  return (
    [
      ...document.querySelectorAll<HTMLElement>(
        `[data-sheet-row="${CSS.escape(id)}"]`,
      ),
    ].find((element) => element.getClientRects().length > 0) ?? null
  );
}

/**
 * When the reader last moved the page themself (wheel, touch, keys, the
 * scrollbar): only their scrolling stops following, never the sheet's own
 * (following, coming back, a refetch).
 */
let readerScrolledAt = 0;
const READER_SCROLL_WINDOW_MS = 800;
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);
function noteReaderScroll(): void {
  readerScrolledAt = Date.now();
}
function noteScrollKey(event: KeyboardEvent): void {
  if (SCROLL_KEYS.has(event.key)) noteReaderScroll();
}
/** A press on the scroll area itself is its scrollbar, not a button in it. */
function noteScrollbarPress(event: PointerEvent): void {
  if (event.target === scrollWatched) noteReaderScroll();
}
// Turning it on scrolls to the debate: that scroll is the sheet's own.
watch(follow, (on) => {
  if (on) readerScrolledAt = 0;
});
function onSheetScroll(): void {
  if (!follow.value) return;
  if (Date.now() - readerScrolledAt > READER_SCROLL_WINDOW_MS) return;
  const row = debatedRow();
  const area = scrollArea();
  if (!row || !area) return;
  const box = row.getBoundingClientRect();
  const view = area.getBoundingClientRect();
  if (box.bottom <= view.top || box.top >= view.bottom) follow.value = false;
}

let scrollWatched: HTMLElement | null = null;
onMounted(() => {
  void nextTick(() => {
    scrollWatched = scrollArea();
    if (!scrollWatched) return;
    scrollWatched.addEventListener("scroll", onSheetScroll, { passive: true });
    scrollWatched.addEventListener("wheel", noteReaderScroll, {
      passive: true,
    });
    scrollWatched.addEventListener("touchmove", noteReaderScroll, {
      passive: true,
    });
    // The scrollbar: a press on the scroll area itself.
    scrollWatched.addEventListener("pointerdown", noteScrollbarPress);
    window.addEventListener("keydown", noteScrollKey);
  });
});
onBeforeUnmount(() => {
  scrollWatched?.removeEventListener("scroll", onSheetScroll);
  scrollWatched?.removeEventListener("wheel", noteReaderScroll);
  scrollWatched?.removeEventListener("touchmove", noteReaderScroll);
  scrollWatched?.removeEventListener("pointerdown", noteScrollbarPress);
  window.removeEventListener("keydown", noteScrollKey);
});

// Back to where the reader left it (-return.ts) -------------------------------

/**
 * While the sheet comes back to where it was left, following the debate
 * moves nothing (unless the debate moved meanwhile).
 */
let holdFollow = false;

/** The scroll area: the hub's panel body, not the window. */
function scrollArea(): HTMLElement | null {
  return tabsAnchor.value ? scrollParentOf(tabsAnchor.value) : null;
}

/** Each row of the list shown (the table or the cards), in page order. */
function rowBoxes(): { id: string; top: number; bottom: number }[] {
  if (!import.meta.client) return [];
  return [...document.querySelectorAll<HTMLElement>("[data-sheet-row]")]
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => {
      const box = element.getBoundingClientRect();
      return {
        id: element.dataset.sheetRow ?? "",
        top: box.top,
        bottom: box.bottom,
      };
    });
}

/** The bottom of the sticky tabs, where a row starts being in view. */
function barBottom(): number {
  return tabsBar.value?.getBoundingClientRect().bottom ?? 0;
}

/**
 * Writes where the reader is into this page's own history entry: on leaving
 * (a link, the app's navigation) and when the page itself goes (a reload).
 * Only while the browser's entry is still the sheet's: on Back or Forward
 * it has already moved to the other one, which must not get it.
 */
function saveReturn(): void {
  const id = assembly.value?.id;
  if (!import.meta.client || !id) return;
  const entry = window.history.state as { current?: unknown } | null;
  if (entry?.current !== route.fullPath) return;
  tabQueries.set(tab.value, currentSheetQuery());
  const queries: SheetReturnState["tabQueries"] = {};
  for (const [key, query] of tabQueries) {
    queries[key as SheetReturnTab] = Object.fromEntries(
      Object.entries(query).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  const saved: SheetReturnState = {
    assemblyId: id,
    scrollTop: scrollArea()?.scrollTop ?? 0,
    anchor: firstRowInView(rowBoxes(), barBottom()),
    follow: follow.value,
    live: {
      agendaItemId: live.value?.agendaItemId ?? null,
      documentId: live.value?.documentId ?? null,
      amendmentId: live.value?.amendmentId ?? null,
    },
    tabQueries: queries,
    search: searchDraft.value,
  };
  try {
    window.history.replaceState(
      withSheetReturn(window.history.state, saved),
      "",
    );
  } catch {
    // A browser refusing the state only loses the way back.
  }
}
onBeforeRouteLeave(saveReturn);
if (import.meta.client) useEventListener(window, "pagehide", saveReturn);

/**
 * Puts the list back where it was: the saved scroll first, then, once laid
 * out, the saved row where it was under the tabs. Given up as soon as the
 * reader scrolls.
 */
function restoreScroll(saved: SheetReturnState, done: () => void): void {
  const area = scrollArea();
  if (!area) {
    done();
    return;
  }
  let cancelled = false;
  const letGo = () => {
    cancelled = true;
  };
  const keys = (event: KeyboardEvent) => {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
      ].includes(event.key)
    ) {
      letGo();
    }
  };
  area.addEventListener("wheel", letGo, { passive: true });
  area.addEventListener("touchmove", letGo, { passive: true });
  window.addEventListener("keydown", keys);
  const finish = () => {
    area.removeEventListener("wheel", letGo);
    area.removeEventListener("touchmove", letGo);
    window.removeEventListener("keydown", keys);
    done();
  };
  requestAnimationFrame(() => {
    if (cancelled) return finish();
    area.scrollTop = saved.scrollTop;
    requestAnimationFrame(() => {
      const anchor = saved.anchor;
      const row = anchor
        ? rowBoxes().find((entry) => entry.id === anchor.rowId)
        : undefined;
      if (!cancelled && anchor && row) {
        area.scrollTop = scrollTopForAnchor(
          area.scrollTop,
          row.top,
          barBottom(),
          anchor.offset,
        );
      }
      finish();
    });
  });
}

onMounted(async () => {
  const id = assembly.value?.id;
  const saved = id
    ? readSheetReturn(window.history.state, id, SHEET_FILTER_QUERY_KEYS)
    : null;
  if (!saved) {
    void followDebate();
    return;
  }
  // Kept in the entry: Back again after Forward, or a reload, finds the
  // latest place written on leaving.
  const moved = saved.follow && debateMoved(saved.live, live.value);
  holdFollow = !moved;
  follow.value = saved.follow;
  for (const [key, query] of Object.entries(saved.tabQueries)) {
    if (key !== tab.value) tabQueries.set(key as SheetTab, query);
  }
  if (saved.search && saved.search !== searchDraft.value) {
    searchDraft.value = saved.search;
  }
  // The debate moved: follow it, unless there is nothing to follow
  // («Turnos de palabra», nothing on screen, its document already shown);
  // then the sheet comes back where it was left.
  if (moved) {
    if (await followDebate()) return;
    holdFollow = true;
  }
  const release = () => {
    holdFollow = false;
  };
  // «Enmiendas» waits for its document's amendments, fetched again on the
  // way back.
  if (tab.value === "amendments" && !amendmentsData.value) {
    const stop = watch(amendmentsData, (data) => {
      if (!data) return;
      stop();
      void nextTick(() => restoreScroll(saved, release));
    });
    // Nothing coming (no document, a failed fetch): let following go.
    setTimeout(() => {
      stop();
      release();
    }, 5000);
    return;
  }
  void nextTick(() => restoreScroll(saved, release));
});

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
    <div
      ref="tabsAnchor"
      class="flex flex-wrap items-start justify-between gap-3"
    >
      <div class="min-w-0 space-y-1">
        <h2 class="text-highlighted text-xl font-semibold">
          {{ t("controlSheet.title") }}
        </h2>
        <p class="text-muted max-w-3xl text-sm">
          {{ t(internal ? "controlSheet.intro" : "controlSheet.introPublic") }}
        </p>
      </div>
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
      <!--
        The tabs stick to the top of the scroll area (its padding is what the
        negative offset takes back), so changing tab never needs scrolling
        up. The heading above them tells whether they are stuck.
      -->
      <div
        ref="tabsBar"
        class="bg-default sticky -top-4 z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1 sm:-top-6"
      >
        <UTabs
          v-model="tab"
          :items="tabItems"
          :content="false"
          variant="link"
          class="min-w-0"
          :aria-label="t('controlSheet.tabs.label')"
        />
        <!-- In the bar that stays on top (user's decision of 2026-11-20):
             it says when the sheet follows the debate, and takes it back
             there when it does not. -->
        <UTooltip
          :text="
            follow
              ? t('controlSheet.followingHint')
              : t('controlSheet.followHint')
          "
        >
          <UButton
            :color="follow ? 'primary' : 'neutral'"
            :variant="follow ? 'soft' : 'outline'"
            size="sm"
            icon="i-lucide-radio"
            :label="
              follow ? t('controlSheet.following') : t('controlSheet.follow')
            "
            :aria-pressed="follow"
            @click="follow = !follow"
          />
        </UTooltip>
      </div>

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
          >
            <template #actions>
              <UButton
                v-if="generalPackageDocuments.length > 0"
                icon="i-lucide-folder-down"
                color="neutral"
                variant="ghost"
                size="sm"
                :label="t('controlSheet.download.button')"
                :aria-label="t('controlSheet.download.general')"
                data-testid="sheet-download-general"
                @click="openGeneralPackage"
              />
            </template>
          </ControlSheetToolbar>
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
            :amendment-counts="amendmentCounts"
            :own-notes="ownNotes"
            @open="openItem"
            @sort="onGeneralSort"
            @amendments="openDocumentAmendments"
            @preview="openDocumentPreview"
          />
        </template>
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
          <div class="flex max-w-3xl flex-wrap items-end gap-2">
            <UFormField
              :label="t('controlSheet.document.label')"
              class="min-w-0 flex-1 basis-64"
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
            <UButton
              v-if="selectedDocument"
              color="neutral"
              variant="outline"
              icon="i-lucide-scan-eye"
              :label="t('controlSheet.preview.selected')"
              :aria-label="
                t('controlSheet.preview.documentAria', {
                  title: selectedDocument.title,
                })
              "
              @click="openDocumentPreview(selectedDocument)"
            />
          </div>
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
            >
              <template #actions>
                <UButton
                  v-if="
                    selectedDocument?.status === 'published' &&
                    shownAmendments.length > 0
                  "
                  icon="i-lucide-folder-down"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :label="t('controlSheet.download.button')"
                  :aria-label="t('controlSheet.download.amendments')"
                  data-testid="sheet-download-amendments"
                  @click="openAmendmentsPackage"
                />
              </template>
            </ControlSheetToolbar>
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
              :own-notes="ownNotes"
              @open="openAmendment"
              @sort="onAmendmentSort"
              @preview="openAmendmentPreview"
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

    <ExportPackageDialog
      v-model:open="packageOpen"
      :api-base="apiBase"
      :preset="packagePreset"
    />

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
      :own-notes="panelOwnNotes"
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
      @speakers-updated="onSpeakersUpdated"
      @result-changed="onResultChanged"
      @reopen="reopenPanel"
      @notes-changed="refreshOwnNotes"
    />

    <LiveViewDocumentWindow
      v-model:open="previewDocumentOpen"
      :document="previewDocumentId ? (previewDocument ?? null) : null"
      :requested-id="previewDocumentId"
      :loading="previewLoading"
      :failed="previewFailed"
      :scroll="null"
      :document-path="previewDocumentPath"
      :live="false"
      :description="t('controlSheet.preview.documentDescription')"
    />
    <LiveViewAmendmentWindow
      v-model:amendment-id="previewAmendmentId"
      :rows="previewRows"
      :note-rows="previewNoteRows"
      :document="previewAmendment ? (previewDocument ?? null) : null"
      :loading="previewLoading"
      :failed="previewFailed"
      :show-position="showPositions"
      :document-path="previewDocumentPath"
    />
  </div>
</template>

<script setup lang="ts">
import type {
  AmendmentDto,
  DocumentAmendmentsDto,
  DocumentDto,
  HeadcountsDto,
  LiveScrollDto,
  LiveStateDto,
  PartialDocumentAmendmentsDto,
  SpeakerNotesDto,
  SpeakersDto,
  SpeakingTurnDto,
} from "~~/shared/types/api";
import { provideAmendmentLinks } from "~/composables/amendment/amendmentLinks";
import {
  seedOrRead,
  settledForHandover,
  useDocumentHandover,
} from "~/composables/amendment/documentHandover";
import { partialAmendmentsRefetch } from "~/composables/amendment/partialAmendments";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import { notesSpeakers } from "~~/shared/utils/permissionRules";
import { positionsArePublic } from "~~/shared/utils/positions";
import { errorStatus } from "~/composables/api/useApi";
import { agendaWithTitles } from "~/utils/agendaTitles";
import { affectsDocumentDto } from "~/composables/assembly/-liveFilters";
import { holdEarlyLive } from "~/composables/assembly/-liveWiring";
import {
  followLiveState,
  liveStateDocumentDelay,
} from "~/composables/live/-liveState";
import {
  sharedAgendaAction,
  useSharedAgendaFetch,
} from "~/composables/assembly/useCurrentAssembly";
import {
  keepLastGoodData,
  useRetryFailed,
} from "~/composables/fetch/lastGoodData";
import { buildSessionAgendaRows } from "~/composables/session/sessionModel";
import {
  affectsAgenda,
  affectsLiveVote,
  affectsSpeakers,
  affectsSpokenTurns,
  isNewerScroll,
  liveAmendmentCode,
  liveAmendmentNote,
  liveAmendmentRows,
  liveBlocEntries,
  liveSpeakers,
  liveVoteAmendments,
  liveVoteGroupSubject,
  liveVoteQuestion,
  liveVoteSubject,
  liveVoteSubjectText,
} from "~/components/live-view/-model";
import {
  affectsHeadcounts,
  liveAttendance,
} from "~/components/live-view/-attendance";

/**
 * Live view for attendees (/asambleas/<slug>/directo), phone first: what
 * the Mesa has in debate (agenda item, document, amendment with its change
 * in readable type), who has the floor and who is next while the Mesa
 * shows it, the last result, and where every amendment of the document
 * stands, with the provisional consolidated text one tap away. The
 * document on screen opens in a floating window that follows the part the
 * Mesa shows (LiveViewDocumentWindow), and each amendment in a preview
 * window (LiveViewAmendmentWindow), without leaving the page. Whoever notes
 * the speakers (the Mesa and session:record_speakers) notes here who spoke
 * on what is in debate (SpeakerNotesEditor); nobody else fetches anything
 * of it.
 *
 * Open to everyone who can see the assembly, at any time: before the
 * session and after it, it says so and points to what can be read
 * meanwhile. It follows the hub's live stream (useCurrentAssembly().onLive),
 * refreshing only what each event touches, takes the live state as the
 * stream pushes it (onLiveState) instead of reading it after every move of
 * the Mesa, and keeps the last good data when a refresh fails, like the
 * projection; when the live state never loaded, it says so rather than
 * "nothing is being debated".
 * Only published amendments are listed, so the Mesa sees what the room sees.
 * A bloc the Mesa proposes to approve together shows as a notice with its
 * codes, approved ones marked (user's decision of 2026-11-19).
 * The Mesa's latest headcount (attendance, delegations, quorum and the
 * majorities it gives) is public too, for transparency.
 * For the same reason, the main presenter's answer to the amendment in
 * debate shows only when the assembly does not keep answers to the Mesa
 * (the server already leaves them out for whoever may not see them).
 */

const { t, locale } = useI18n();
const api = useApi();
const {
  assembly,
  apiBase,
  sectionPath,
  onLive,
  onLiveScroll,
  onLiveState,
  live: stream,
} = useCurrentAssembly();

useHead({
  title: () =>
    [t("liveView.title"), assembly.value?.label].filter(Boolean).join(" · "),
});

const status = computed(() => assembly.value?.status ?? null);
const inSession = computed(() => status.value === "in_session");
const assemblyKey = computed(() => assembly.value?.id ?? "none");

/** Gone for this view: deleted, hidden, or an endpoint not available. */
function isGone(error: unknown): boolean {
  const code = errorStatus(error);
  return code === 403 || code === 404;
}

/** Something this view cannot read means nothing to show; rethrow the rest. */
function nullIfGone(error: unknown): null {
  if (isGone(error)) return null;
  throw error;
}

// Data ---------------------------------------------------------------------------
//
// Nothing is fetched outside the session. The live state decides which
// document (and amendments) to fetch, so those wait for it.
//
// Only the live state and the speaking turns hold the page back: the
// headcounts, the document and its amendments are lazy, and the agenda is
// not awaited, so a phone that comes back to Directo shows what is in
// debate after one round of requests instead of two in a row, with
// placeholders where the rest is still on its way (`itemLoading`,
// `debateLoading`, `amendmentsReady`).
// Server rendering still waits for all of them.
//
// The agenda (only for the title of the item in debate) is the one the
// agenda and document pages share (useSharedAgendaFetch, one key), so
// moving between them and Directo hands over the agenda already downloaded
// instead of fetching it again; it is not awaited, and not `lazy`, which
// would refetch an agenda just handed over. Directo keeps its own filter,
// though: this is the page every delegate keeps open on a phone, and an
// amendment published or withdrawn must not make each of them fetch the
// whole agenda again. It refreshes only when the titles can change
// (affectsAgenda), as on the projection, and only in session; an event it
// lets through that the agenda pages follow marks the agenda behind, and
// the next of them refetches it (sharedAgendaAction).

// The live handler reads what the await below returns, so it is registered
// after it; a batch that arrives meanwhile is held and handed to it then
// (holdEarlyLive), or what it changed would wait for the next event.
const registerLive = holdEarlyLive(onLive);
// The document pages hand over the document and its amendments they hold,
// and take them from here, instead of downloading them again
// (documentHandover), while the stream is connected. Before the await: it
// reads the app's context.
const documentHandover = useDocumentHandover(stream);

const { result: agendaFetch, markBehind: markAgendaBehind } =
  useSharedAgendaFetch({ immediate: inSession.value });
const headcountsFetch = useAsyncData(
  () => `live-view-headcounts-${assemblyKey.value}`,
  () =>
    inSession.value
      ? api.get<HeadcountsDto>(`${apiBase.value}/headcounts`).catch(nullIfGone)
      : Promise.resolve(null),
  { lazy: true },
);
/**
 * The live state in order (`updatedAt`): pushed on the stream after each
 * move of the Mesa (onLiveState), read on a poll, a reconnection, a change
 * of the vote on screen or when no push covered a batch. A push that moves
 * to another document waits this phone's share of a second, so the room
 * does not download that document and its amendments in the same instant.
 */
const liveShare = Math.random();
const liveFollower = followLiveState({
  apply: (state) => {
    liveState.value = state;
  },
  delayMs: (state) =>
    liveStateDocumentDelay(state, liveState.value, {
      spread: !assembly.value?.can.moderate,
      share: liveShare,
    }),
});
onScopeDispose(liveFollower.dispose);
const [liveFetch, speakersFetch] = await Promise.all([
  useAsyncData(
    () => `live-view-state-${assemblyKey.value}`,
    () =>
      inSession.value
        ? api
            .get<LiveStateDto>(`${apiBase.value}/live-state`)
            .then((state) => liveFollower.fetched(state) ?? state)
        : Promise.resolve(null),
  ),
  useAsyncData(
    () => `live-view-speakers-${assemblyKey.value}`,
    () =>
      inSession.value
        ? api.get<SpeakersDto>(`${apiBase.value}/speakers`).catch(nullIfGone)
        : Promise.resolve(null),
  ),
]);
const {
  data: liveState,
  stale: liveStale,
  failed: liveFailed,
} = keepLastGoodData(liveFetch, { isGone });
// What the page holds (server-rendered, or read above) is the state to
// beat; a push that came while the page loaded is handed over now, and
// kept only if newer than that read (`replay`).
liveFollower.fetched(liveState.value ?? null);
onLiveState(liveFollower.pushed);
const {
  data: speakersDto,
  stale: speakersStale,
  failed: speakersFailed,
} = keepLastGoodData(speakersFetch, { isGone });
const {
  data: fetchedAgenda,
  stale: agendaStale,
  failed: agendaFailed,
} = keepLastGoodData(agendaFetch, { isGone });
// An item sent without its title gets a neutral one (titleHidden).
const agenda = agendaWithTitles(fetchedAgenda, () => t("agenda.hiddenTitle"));
const {
  data: headcountsDto,
  stale: headcountsStale,
  failed: headcountsFailed,
} = keepLastGoodData(headcountsFetch, { isGone });

const live = computed<LiveStateDto | null>(() =>
  inSession.value ? (liveState.value ?? null) : null,
);
const documentId = computed(() => live.value?.documentId ?? null);
const documentUrl = computed(() =>
  documentId.value
    ? `${apiBase.value}/documents/${encodeURIComponent(documentId.value)}`
    : null,
);

// Coming from the page of the document in debate (still mounted while this
// one loads): what it holds up to date is shown at once instead of read
// again (documentHandover). Never on the server or while hydrating. The
// live handler registered below gets every batch since the await began
// (registerLive), so nothing that changed them meanwhile is missed.
const handed = documentHandover.find(assembly.value?.id, documentId.value);
const documentFetch = useAsyncData(
  () => `live-view-document-${documentId.value ?? "none"}`,
  () =>
    documentUrl.value
      ? api.get<DocumentDto>(documentUrl.value).catch(nullIfGone)
      : Promise.resolve(null),
  // `lazy` would read it before mount even when seeded.
  { lazy: true, immediate: !handed },
);
const amendmentsFetch = useAsyncData(
  () => `live-view-amendments-${documentId.value ?? "none"}`,
  () =>
    documentUrl.value
      ? api
          .get<DocumentAmendmentsDto>(`${documentUrl.value}/amendments`)
          .catch(nullIfGone)
      : Promise.resolve(null),
  { lazy: true, immediate: !handed?.amendments },
);
if (handed) {
  // Before keepLastGoodData, which then counts them as good.
  seedOrRead(documentFetch, handed.document);
  if (handed.amendments) seedOrRead(amendmentsFetch, handed.amendments);
  // Not `immediate`: Nuxt reads a new key only when the previous one had
  // data. When the Mesa moves on, a key left unread is read here.
  watch(documentId, () => {
    if (documentFetch.status.value === "idle") void documentFetch.refresh();
    if (amendmentsFetch.status.value === "idle") {
      void amendmentsFetch.refresh();
    }
  });
}
// Reset when the Mesa moves to another document: the previous one must not
// stand in for it.
const {
  data: documentData,
  stale: documentStale,
  failed: documentFailed,
} = keepLastGoodData(documentFetch, { isGone, resetOn: documentId });
const {
  data: amendmentsData,
  stale: amendmentsStale,
  failed: amendmentsFailed,
} = keepLastGoodData(amendmentsFetch, { isGone, resetOn: documentId });

/**
 * A live batch of the document reads only the amendments it changed when
 * it can, the whole list otherwise (partialAmendmentsRefetch): every phone
 * of the room keeps this page open, and the list weighs hundreds of KB.
 */
const amendmentsLive = partialAmendmentsRefetch({
  documentId: () => documentId.value,
  current: () => {
    const dto = amendmentsData.value;
    return dto &&
      !amendmentsFailed.value &&
      dto.amendments.every((item) => item.documentId === documentId.value)
      ? dto
      : null;
  },
  write: (dto) => {
    amendmentsData.value = dto;
  },
  refreshAll: () => amendmentsFetch.refresh({ dedupe: "cancel" }),
  readSome: (ids) =>
    documentUrl.value
      ? api.get<PartialDocumentAmendmentsDto>(
          `${documentUrl.value}/amendments`,
          { ids: ids.join(",") },
        )
      : Promise.reject(new Error("No document in debate")),
  readingAll: () => amendmentsFetch.status.value === "pending",
});
watch(
  amendmentsFetch.status,
  (status) => {
    if (status === "pending") amendmentsLive.readAllStarted();
  },
  { flush: "sync" },
);

// What this page offers the document page ("Abrir enmienda"): the
// document in debate and its list, each only while read, its last read
// not failed and no read of it on its way. Nothing when this page was left
// while the await above was pending (addSource).
documentHandover.register({
  assemblyId: () => assembly.value?.id,
  document: () => {
    const dto = documentData.value;
    return dto &&
      dto.id === documentId.value &&
      settledForHandover({
        status: documentFetch.status.value,
        failed: documentFailed.value,
      })
      ? dto
      : null;
  },
  amendments: () =>
    settledForHandover({
      status: amendmentsFetch.status.value,
      failed: amendmentsFailed.value,
      busy: amendmentsLive.busy(),
    })
      ? (amendmentsData.value ?? null)
      : null,
});

/** Some source failed its last refresh and shows its last good data. */
const stale = computed(
  () =>
    liveStale.value ||
    speakersStale.value ||
    agendaStale.value ||
    headcountsStale.value ||
    documentStale.value ||
    amendmentsStale.value,
);

/**
 * Some source failed its last refresh, whether or not it had data to keep
 * (one that never loaded is not `stale`, but it is not up to date either).
 */
const failed = computed(
  () =>
    liveFailed.value ||
    speakersFailed.value ||
    agendaFailed.value ||
    headcountsFailed.value ||
    documentFailed.value ||
    amendmentsFailed.value,
);

/**
 * The live state never arrived (a 5xx or no network on the first request):
 * nothing can be said about the debate, which may well be under way, so the
 * page must not claim that nothing is being debated.
 */
const liveLoadFailed = computed(() => !liveState.value && liveFailed.value);

/** The document in debate, never another one while the new one loads. */
const document = computed<DocumentDto | null>(() =>
  documentData.value && documentData.value.id === documentId.value
    ? documentData.value
    : null,
);
/** The document in debate came back empty: this account cannot see it. */
const documentGone = computed(
  () =>
    documentId.value !== null &&
    documentFetch.status.value === "success" &&
    !documentData.value,
);
/** The Mesa put a document on screen that is still on its way. */
const documentLoading = computed(
  () =>
    documentId.value !== null &&
    !document.value &&
    !documentFailed.value &&
    !documentGone.value,
);
const amendments = computed<AmendmentDto[]>(() =>
  (amendmentsData.value?.amendments ?? []).filter(
    (amendment) => amendment.documentId === documentId.value,
  ),
);
/**
 * The amendments of the document in debate have arrived (not the previous
 * document's, which Nuxt may keep under the new key while it loads).
 */
const amendmentsLoaded = computed(
  () =>
    Boolean(document.value) &&
    Boolean(amendmentsData.value) &&
    amendmentsFetch.status.value !== "pending",
);
/**
 * The document whose amendments arrived at least once: a refresh keeps the
 * list on screen, only a first load (entering the page, the Mesa moving to
 * another document) shows placeholders.
 */
const amendmentsSeenFor = ref<string | null>(null);
watch(
  [amendmentsLoaded, documentId],
  ([loaded, id]) => {
    if (loaded) amendmentsSeenFor.value = id;
  },
  { immediate: true },
);
/**
 * The amendments of the document in debate arrived: loaded now, or once
 * before this refresh. Read from `amendmentsLoaded` too, not only the
 * watcher's mark: on the server an immediate watcher runs once in setup,
 * before the lazy fetch resolves, and never again, so the server render
 * must not wait for it (it would render placeholders the client then
 * replaces, a hydration mismatch).
 */
const amendmentsArrived = computed(
  () =>
    documentId.value !== null &&
    (amendmentsLoaded.value || amendmentsSeenFor.value === documentId.value),
);
/** The amendments of the document in debate are here, or will not come. */
const amendmentsReady = computed(
  () =>
    amendmentsArrived.value ||
    amendmentsFailed.value ||
    documentFailed.value ||
    documentGone.value,
);

// Live updates -----------------------------------------------------------------

/** When the view last heard from the server. */
const lastUpdate = ref<Date | null>(null);

// With any batch that came while the page loaded (registerLive).
registerLive((events) => {
  const refreshes: Promise<unknown>[] = [];
  const poll = events.some((event) => event.type === "poll");
  // The vote on screen may change without the live state moving (its
  // unanimity): its own event reads the live state again. A move of the
  // Mesa came pushed (onLiveState) unless no push covered it.
  if (
    poll ||
    (events.some((event) => event.entityType === "live") &&
      !stream.statePushed()) ||
    affectsLiveVote(events, live.value?.vote?.id)
  ) {
    refreshes.push(liveFetch.refresh());
  }
  if (affectsSpeakers(events)) refreshes.push(speakersFetch.refresh());
  const agendaAction = sharedAgendaAction(events, {
    follows: affectsAgenda,
    active: inSession.value,
  });
  // The shared fetch defers to a request in flight; one that left before
  // this batch may miss what it changed.
  if (agendaAction === "refresh") {
    refreshes.push(agendaFetch.refresh({ dedupe: "cancel" }));
  } else if (agendaAction === "behind") {
    markAgendaBehind();
  }
  if (affectsHeadcounts(events)) refreshes.push(headcountsFetch.refresh());
  // The amendments follow every event of the document, some of them read
  // alone when only those changed (amendmentsLive); the document itself
  // only what may change it, not each vote or answer (affectsDocumentDto).
  const amendmentsRead = amendmentsLive.handle(events);
  if (amendmentsRead) refreshes.push(amendmentsRead);
  if (
    documentId.value &&
    affectsDocumentDto(events, documentId.value, document.value?.finalVote?.id)
  ) {
    refreshes.push(documentFetch.refresh());
  }
  // asyncData refreshes resolve even when they fail: only stamp the time
  // when every source is up to date.
  void Promise.all(refreshes).then(() => {
    if (!failed.value) lastUpdate.value = new Date();
  });
});

// Live events only refresh what they touch: a refresh that fails while the
// stream stays up is retried here until it succeeds, as on the projection.
useRetryFailed(
  [
    {
      failed: liveFailed,
      status: liveFetch.status,
      refresh: liveFetch.refresh,
    },
    {
      failed: speakersFailed,
      status: speakersFetch.status,
      refresh: speakersFetch.refresh,
    },
    {
      failed: agendaFailed,
      status: agendaFetch.status,
      refresh: agendaFetch.refresh,
    },
    {
      failed: headcountsFailed,
      status: headcountsFetch.status,
      refresh: headcountsFetch.refresh,
    },
    {
      failed: documentFailed,
      status: documentFetch.status,
      refresh: documentFetch.refresh,
    },
    {
      failed: amendmentsFailed,
      status: amendmentsFetch.status,
      refresh: amendmentsFetch.refresh,
    },
  ],
  {
    onRecovered: () => {
      lastUpdate.value = new Date();
    },
  },
);

// The session starts or ends while the page is open: the hub refreshes the
// assembly; the keys stay the same, so fetch again by hand. The agenda only
// when it starts: outside the session nothing shows it.
watch(inSession, (now) => {
  void liveFetch.refresh();
  void speakersFetch.refresh();
  if (now) void agendaFetch.refresh();
  void headcountsFetch.refresh();
});

/** "Reintentar" on the load-failed state: the automatic retry goes on too. */
const retrying = ref(false);
async function retryNow(): Promise<void> {
  retrying.value = true;
  try {
    await Promise.all([
      liveFetch.refresh(),
      speakersFetch.refresh(),
      inSession.value ? agendaFetch.refresh() : null,
      headcountsFetch.refresh(),
    ]);
    if (!failed.value) lastUpdate.value = new Date();
  } finally {
    retrying.value = false;
  }
}

// Derived ------------------------------------------------------------------------

const agendaRows = computed(() =>
  buildSessionAgendaRows(
    agenda.value?.items ?? [],
    agenda.value?.documents ?? [],
  ),
);
const currentRow = computed(
  () =>
    agendaRows.value.find((row) => row.item.id === live.value?.agendaItemId) ??
    null,
);

const debatedId = computed(() => live.value?.amendmentId ?? null);
// Grouped by the main presenter's answers as the reader gets them, as on
// the Mesa's console (user's decision of 2026-11-19).
const amendmentRows = computed(() =>
  liveAmendmentRows(amendments.value, debatedId.value, { byAnswer: true }),
);
const debated = computed(
  () => amendmentRows.value.find((row) => row.current) ?? null,
);
/**
 * What the badge of the debated amendment does not explain: who replaced
 * it, that it is in the text without a vote, or what a transactional
 * replaced or still waits for.
 */
const debatedNote = computed(() => {
  const note = debated.value
    ? liveAmendmentNote(debated.value, amendmentRows.value)
    : null;
  return note ? t(note.key, note.params ?? {}) : null;
});
/**
 * The room may see the main presenter's answers. The Mesa, the Secretaría
 * and the presenters always receive them, but this page shows what the room
 * sees, so it follows whether the document's answers are public
 * (positionsArePublic) rather than what arrived.
 */
const settings = computed(() => ({
  ...DEFAULT_ASSEMBLY_SETTINGS,
  ...assembly.value?.settings,
}));
const showPosition = computed(() =>
  document.value ? positionsArePublic(document.value) : false,
);
/** The Mesa's latest headcount, public; null before its first count. */
const attendance = computed(() =>
  liveAttendance(headcountsDto.value, settings.value),
);
/** The Mesa debates an amendment this view cannot list (not public yet). */
const amendmentHidden = computed(
  () =>
    Boolean(debatedId.value) &&
    amendmentsArrived.value &&
    amendmentsFetch.status.value !== "pending" &&
    !debated.value,
);
/** The agenda (for the item's title) is still on its way. */
const itemLoading = computed(
  () =>
    Boolean(live.value?.agendaItemId) &&
    !currentRow.value &&
    agendaFetch.status.value === "pending",
);
/**
 * The document in debate, or the amendment in debate, is on its way (the
 * list is loading, or being read again because it lacked that amendment).
 */
const debateLoading = computed(
  () =>
    documentLoading.value ||
    (Boolean(debatedId.value) &&
      !debated.value &&
      (!amendmentsReady.value || amendmentsFetch.status.value === "pending")),
);

// A transactional drafted in the room is put in debate as soon as it is
// published: fetch the list again if the live state names one it lacks.
watch(debatedId, (id) => {
  if (
    id &&
    amendmentsLoaded.value &&
    !amendments.value.some((amendment) => amendment.id === id)
  ) {
    void amendmentsFetch.refresh();
  }
});

/**
 * The bloc on screen, as the room reads it (liveBlocEntries); with a
 * purpose, a proposal to admit late amendments or not (user's decision of
 * 2026-11-21).
 */
const blocPurpose = computed(() => live.value?.amendmentBlocPurpose ?? null);
const blocEntries = computed(() =>
  liveBlocEntries(
    live.value?.amendmentBloc,
    amendments.value,
    blocPurpose.value,
  ),
);
const blocApproved = computed(
  () => blocEntries.value.filter((entry) => entry.approved).length,
);

const nothingInDebate = computed(
  () => !live.value?.agendaItemId && !documentId.value,
);

const message = computed(() => live.value?.message?.trim() || null);
/** A recess the Mesa called, and when the session resumes if it said. */
const recessLine = computed(() => {
  const recess = live.value?.recess;
  if (!recess) return null;
  return recess.until
    ? t("liveView.recessUntil", {
        time: formatTime(recess.until, { locale: locale.value }),
      })
    : t("liveView.recess");
});

const speakers = computed(() =>
  inSession.value
    ? liveSpeakers(speakersDto.value, live.value?.speakersVisible ?? false)
    : null,
);

const vote = computed(() => live.value?.vote ?? null);
// An agenda item's vote names the item as this account reads it in its own
// agenda; one it does not receive reads as "un punto del orden del día".
const voteSubjectKind = computed(() =>
  vote.value
    ? liveVoteSubject(vote.value, {
        amendments: amendments.value,
        document: document.value,
        agenda: agendaRows.value,
        decision: live.value?.voteDecision ?? null,
      })
    : null,
);
/**
 * The amendments the reader reads, as the list has them: the codes of a
 * bloc or an alternative open the preview window only on those.
 */
const listedAmendments = computed(() =>
  amendmentRows.value.map((row) => row.amendment),
);
const voteSubject = computed(() => {
  if (!vote.value) return "";
  // A bloc or alternatives vote names its amendments, not the decision.
  const group = liveVoteGroupSubject(
    liveVoteAmendments(vote.value, listedAmendments.value),
    t,
  );
  if (group) return group;
  return voteSubjectKind.value
    ? liveVoteSubjectText(voteSubjectKind.value, t)
    : "";
});
/** What an agenda item's vote decided, unless the heading already says it. */
const voteQuestion = computed(() =>
  vote.value && voteSubjectKind.value
    ? liveVoteQuestion(
        vote.value,
        voteSubjectKind.value,
        t("agenda.unlisted.inText"),
      )
    : null,
);

const documentPath = computed(() =>
  document.value
    ? `${sectionPath("documentos")}/${encodeURIComponent(document.value.slug)}`
    : null,
);
const showAmendments = computed(
  () =>
    document.value?.format === "structured" &&
    document.value.amendable === true,
);
const consolidatedPath = computed(() =>
  showAmendments.value && document.value?.baseVersion && documentPath.value
    ? `${documentPath.value}/consolidado`
    : null,
);

// The document on screen and the amendments, in floating windows ----------------

const documentWindowOpen = ref(false);

/**
 * Where the Mesa has the document in debate scrolled: each position comes
 * on the stream; the last one is read when the panel opens or the Mesa
 * moves to another document while it is open.
 */
const mesaScroll = ref<LiveScrollDto | null>(null);
onLiveScroll((scroll) => {
  mesaScroll.value = scroll;
});
async function readMesaScroll(): Promise<void> {
  if (!documentId.value) return;
  try {
    const scroll = await api.get<LiveScrollDto | null>(
      `${apiBase.value}/live-scroll`,
    );
    // A position that came on the stream meanwhile is newer: keep it.
    if (scroll && isNewerScroll(mesaScroll.value, scroll)) {
      mesaScroll.value = scroll;
    }
  } catch {
    // The next position the Mesa sends puts it right.
  }
}
/**
 * Opens the window at once; it moves to where the Mesa is when that
 * arrives (its `scroll` prop). The last position is always read in the
 * background: one the page holds may be old even with the stream up again
 * (positions missed while it was down or polling are never replayed), and
 * isNewerScroll keeps a push that arrives meanwhile.
 */
function openDocumentWindow(): void {
  documentWindowOpen.value = true;
  void readMesaScroll();
}
watch(documentId, () => {
  if (documentWindowOpen.value) void readMesaScroll();
});

// Who spoke on what is in debate, for whoever notes it --------------------------

const { can } = useMe();
const canNoteSpeakers = computed(() => notesSpeakers(can));
const spokenTurns = ref<SpeakingTurnDto[]>([]);
/**
 * Counts the reads and the editor's own saves: a read that one of them
 * overtook is dropped, so it never hides a note just saved.
 */
let spokenTurnsVersion = 0;
async function readSpokenTurns(): Promise<void> {
  if (!canNoteSpeakers.value || !inSession.value) return;
  const version = ++spokenTurnsVersion;
  try {
    const dto = await api.get<SpeakerNotesDto>(
      `${apiBase.value}/speakers/notes`,
    );
    if (version === spokenTurnsVersion) spokenTurns.value = dto.turns;
  } catch {
    // The next change of the speakers reads them again.
  }
}
/** The editor saved: its answer is the newest list. */
function onSpokenTurnsUpdated(turns: SpeakingTurnDto[]): void {
  spokenTurnsVersion += 1;
  spokenTurns.value = turns;
}
onMounted(() => void readSpokenTurns());
watch(inSession, () => void readSpokenTurns());
// Only what may change the turns that spoke: not a turn joining or moving
// in the queue (affectsSpokenTurns).
onLive((events) => {
  if (affectsSpokenTurns(events)) void readSpokenTurns();
});

/** The amendment previewed from the list; null when none is. */
const previewAmendmentId = ref<string | null>(null);
watch(documentId, () => {
  previewAmendmentId.value = null;
});

// Codes of other amendments in the notes open them in the preview window,
// the page's only preview (user's decisions of 2026-11-20); in the list,
// whose rows are buttons, they stay text.
provideAmendmentLinks({
  inWindow: true,
  get: (id) => amendments.value.find((amendment) => amendment.id === id),
  baseOf: () => null,
  open: (id) => {
    previewAmendmentId.value = id;
  },
});

const now = useAppNow();

/**
 * When the assembly starts, only while that is still ahead: the page also
 * shows the "not open" state after the Mesa suspends the session, when the
 * start has passed.
 */
const startDate = computed(() =>
  assembly.value && new Date(assembly.value.startDate).getTime() > now.value
    ? formatDate(assembly.value.startDate, {
        locale: locale.value,
        style: "long",
      })
    : "",
);

// Screen readers ---------------------------------------------------------------
//
// One short polite line when something changes, instead of live regions
// over the content: a refresh would otherwise read the whole passage aloud.

const announcement = ref("");

// The session ends or is suspended: nothing said about it still holds
// (the debate, the floor or the last result).
watch(inSession, (open) => {
  if (!open) announcement.value = "";
});

/**
 * What was in debate when the page opened is not news: the document and
 * its amendments load after the page shows (lazy), and their arrival must
 * not be read out as a change. Set once that first load is over, after the
 * watcher below has seen it.
 */
let announceDebate = !debateLoading.value;
if (!announceDebate) {
  const stop = watch(
    debateLoading,
    (loading) => {
      if (loading) return;
      announceDebate = true;
      stop();
    },
    { flush: "post" },
  );
}

watch(
  () => debated.value?.amendment.id ?? document.value?.id ?? null,
  (id, previous) => {
    if (!id || id === previous || !announceDebate) return;
    if (debated.value) {
      announcement.value = t("liveView.announce.amendment", {
        code:
          liveAmendmentCode(debated.value.amendment) ||
          t(`session.enums.amendmentKind.${debated.value.amendment.kind}`),
      });
    } else if (document.value) {
      announcement.value = t("liveView.announce.document", {
        title: document.value.title,
      });
    }
  },
);

// The Mesa leaves the document (the debated id above goes null for a moment
// on every switch, so it cannot tell): say so when the page shows that
// nothing is in debate, and otherwise drop the line that no longer holds,
// as when it moves to an item without a document.
watch(documentId, (id, previous) => {
  if (id || !previous) return;
  announcement.value =
    inSession.value && live.value && nothingInDebate.value
      ? t("liveView.idle.title")
      : "";
});

/** The last "now speaking" line, dropped when that turn ends. */
let speakerLine = "";

watch(
  () => speakers.value?.current?.id ?? null,
  (id, previous) => {
    if (id === previous) return;
    const turn = speakers.value?.current;
    if (!id || !turn) {
      if (previous && announcement.value === speakerLine) {
        announcement.value = "";
      }
      return;
    }
    speakerLine = t("liveView.announce.speaker", {
      name:
        turn.speaker?.trim() ||
        turn.member?.name ||
        t("liveView.speakers.unnamed"),
    });
    announcement.value = speakerLine;
  },
);

watch(
  () => vote.value?.id ?? null,
  (id, previous) => {
    if (!id || id === previous || !vote.value) return;
    announcement.value = [
      voteSubject.value,
      vote.value.result === "approved"
        ? t("projection.vote.approved")
        : t("projection.vote.rejected"),
    ].join(": ");
  },
);
</script>

<template>
  <div
    class="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-8"
    :class="inSession ? 'xl:max-w-6xl' : ''"
  >
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </p>

    <!-- The session is not open: before it, or suspended by the Mesa -->
    <CommonEmptyState
      v-if="status === 'draft' || status === 'convened'"
      icon="i-lucide-radio"
      :title="t('liveView.notStarted.title')"
      :description="t('liveView.notStarted.description')"
      variant="outline"
    >
      <!--
        The button goes in the default slot with the date: UEmpty renders its
        actions inside the body, so an #action next to a body would be lost.
      -->
      <p v-if="startDate" class="text-default text-sm">
        {{ t("liveView.notStarted.starts", { date: startDate }) }}
      </p>
      <UButton
        :to="sectionPath('orden-del-dia')"
        icon="i-lucide-list-tree"
        :label="t('liveView.notStarted.agenda')"
      />
    </CommonEmptyState>

    <template v-else-if="status === 'closed'">
      <!-- After the session -->
      <CommonEmptyState
        icon="i-lucide-flag"
        :title="t('liveView.closed.title')"
        :description="t('liveView.closed.description')"
        variant="outline"
      >
        <template #action>
          <UButton
            :to="sectionPath('documentos')"
            icon="i-lucide-files"
            :label="t('liveView.closed.documents')"
          />
        </template>
      </CommonEmptyState>
    </template>

    <template v-else-if="inSession">
      <!-- Connection (the hub's navbar badge is hidden on phones) -->
      <ClientOnly>
        <p
          v-if="stream.connected.value || stream.polling.value || failed"
          class="text-muted -mb-3 flex flex-wrap items-center gap-x-2 text-sm"
        >
          <span
            class="size-2 rounded-full"
            :class="
              stream.connected.value
                ? 'bg-success motion-safe:animate-pulse'
                : 'bg-warning'
            "
            aria-hidden="true"
          />
          {{
            stream.connected.value
              ? t("projection.live")
              : t("projection.polling")
          }}
          <!-- As on the projection: "last data" only when there is some -->
          <template v-if="stale">
            <span aria-hidden="true">·</span>
            <span class="text-warning font-medium">
              {{ t("projection.stale") }}
            </span>
          </template>
          <template v-else-if="failed">
            <span aria-hidden="true">·</span>
            <span class="text-warning font-medium">
              {{ t("projection.loadFailed") }}
            </span>
          </template>
          <template v-else-if="lastUpdate">
            <span aria-hidden="true">·</span>
            <span>
              {{
                t("projection.updated", {
                  time: formatTime(lastUpdate, { locale }),
                })
              }}
            </span>
          </template>
        </p>
      </ClientOnly>

      <!-- A recess -->
      <UAlert
        v-if="recessLine"
        color="warning"
        variant="subtle"
        icon="i-lucide-coffee"
        :title="recessLine"
      />

      <!-- The Mesa's notice -->
      <UAlert
        v-if="message"
        color="secondary"
        variant="subtle"
        icon="i-lucide-megaphone"
        :title="t('liveView.message')"
        :description="message"
        :ui="{ description: 'whitespace-pre-line text-base text-default' }"
      />

      <!-- A bloc the Mesa proposes to approve together, or late amendments
           it proposes to admit to debate or not. -->
      <UAlert
        v-if="blocEntries.length > 0"
        color="primary"
        variant="subtle"
        icon="i-lucide-list-checks"
        :title="
          blocPurpose
            ? t(`projection.proposal.title.${blocPurpose}`)
            : t('liveView.bloc.title')
        "
      >
        <template #description>
          <p v-if="blocPurpose" class="text-default">
            {{ t("projection.proposal.late") }}
          </p>
          <p v-else class="text-default tabular-nums">
            {{
              t("projection.bloc.progress", {
                approved: blocApproved,
                total: blocEntries.length,
              })
            }}
          </p>
          <ul class="mt-2 flex flex-wrap gap-1.5">
            <li v-for="entry in blocEntries" :key="entry.id">
              <UBadge
                size="lg"
                :color="
                  entry.outcome === 'approved' || entry.outcome === 'admitted'
                    ? 'success'
                    : 'neutral'
                "
                :variant="
                  entry.outcome === 'approved' || entry.outcome === 'admitted'
                    ? 'subtle'
                    : 'outline'
                "
                :icon="
                  entry.outcome === 'approved' || entry.outcome === 'admitted'
                    ? 'i-lucide-check'
                    : undefined
                "
                :class="entry.settled ? 'opacity-60' : ''"
              >
                <span class="font-semibold">{{ entry.code }}</span>
                <span v-if="entry.author" class="text-muted">
                  {{ entry.author.acronym }}
                </span>
                <span v-if="entry.outcome === 'approved'" class="sr-only">
                  {{ t("projection.bloc.approved") }}
                </span>
                <span v-else-if="entry.outcome === 'admitted'" class="sr-only">
                  {{ t("projection.proposal.admitted") }}
                </span>
                <span v-else-if="entry.outcome === 'notAdmitted'">
                  · {{ t("projection.proposal.notAdmitted") }}
                </span>
              </UBadge>
            </li>
          </ul>
        </template>
      </UAlert>

      <!--
        From xl the page has two columns: the debate, the notes, the result
        and the amendments on the left; who has the floor and the attendance
        in a column of their own on the right, which stays in view. Below xl
        they keep their place among the rest, in one column, so the order the
        eye follows is the order of the page for the keyboard and screen
        readers too. CSS picks the layout, so the server paints the final one
        at any width with nothing moving after hydration: each block is
        rendered in both places and the one not shown is display:none, out
        of the layout and the accessibility tree.
      -->
      <div
        class="flex flex-col gap-6 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start"
      >
        <div class="flex min-w-0 flex-col gap-6">
          <!--
            The live state never loaded: say so instead of "nothing in
            debate". It is retried on its own (useRetryFailed); the button
            only hurries it.
          -->
          <CommonEmptyState
            v-if="liveLoadFailed"
            icon="i-lucide-wifi-off"
            :title="t('projection.loadFailed')"
            :description="t('liveView.loadFailed')"
            variant="outline"
            size="sm"
          >
            <template #action>
              <UButton
                icon="i-lucide-refresh-ccw"
                color="neutral"
                variant="outline"
                size="lg"
                :loading="retrying"
                :label="t('common.staleData.retry')"
                @click="retryNow"
              />
            </template>
          </CommonEmptyState>

          <template v-else-if="nothingInDebate">
            <!-- Nothing in debate yet -->
            <CommonEmptyState
              icon="i-lucide-hourglass"
              :title="t('liveView.idle.title')"
              :description="t('liveView.idle.description')"
              variant="outline"
              size="sm"
            />
          </template>

          <LiveViewDebate
            v-else
            :row="currentRow"
            :document="document"
            :amendment="debated?.amendment ?? null"
            :state="debated?.state ?? null"
            :note="debatedNote"
            :amendment-hidden="amendmentHidden"
            :document-path="documentPath"
            :show-position="showPosition"
            :item-loading="itemLoading"
            :loading="debateLoading"
            @view-document="openDocumentWindow"
          />
          <LiveViewDocumentWindow
            v-model:open="documentWindowOpen"
            :document="document"
            :loading="documentLoading"
            :scroll="mesaScroll"
            :document-path="documentPath"
            :amendments="amendments"
          />

          <section
            v-if="
              canNoteSpeakers && !nothingInDebate && !amendmentHidden && live
            "
            aria-labelledby="live-notes-title"
            class="flex flex-col gap-3"
          >
            <div>
              <h2
                id="live-notes-title"
                class="text-highlighted text-lg font-semibold"
              >
                {{ t("speakerNotes.title") }}
              </h2>
              <p class="text-muted text-sm">
                {{
                  debated
                    ? t("speakerNotes.onAmendment", {
                        code:
                          liveAmendmentCode(debated.amendment) ||
                          t(
                            `session.enums.amendmentKind.${debated.amendment.kind}`,
                          ),
                      })
                    : t("speakerNotes.onItem")
                }}
              </p>
            </div>
            <div class="ring-default rounded-lg p-4 ring">
              <SpeakerNotesEditor
                :agenda-item-id="live.agendaItemId"
                :amendment-id="debated?.amendment.id ?? null"
                :turns="spokenTurns"
                :writable="true"
                @updated="onSpokenTurnsUpdated"
              />
            </div>
          </section>

          <LiveViewSpeakers
            v-if="speakers"
            :speakers="speakers"
            class="xl:hidden"
          />

          <section
            v-if="vote"
            aria-labelledby="live-result-title"
            class="flex flex-col gap-3"
          >
            <h2
              id="live-result-title"
              class="text-highlighted text-lg font-semibold"
            >
              {{ t("liveView.result.title") }}
            </h2>
            <LiveViewVoteResult
              :vote="vote"
              :subject="voteSubject"
              :question="voteQuestion"
              :amendments="listedAmendments"
            />
          </section>

          <LiveViewAttendance
            v-if="headcountsDto"
            :attendance="attendance"
            class="xl:hidden"
          />

          <LiveViewAmendmentList
            v-if="showAmendments && documentPath && amendmentsReady"
            :rows="amendmentRows"
            :consolidated-path="consolidatedPath"
            @preview="previewAmendmentId = $event"
          />
          <USkeleton
            v-else-if="showAmendments && documentPath"
            aria-hidden="true"
            class="h-40 w-full"
          />
          <LiveViewAmendmentWindow
            v-if="showAmendments"
            v-model:amendment-id="previewAmendmentId"
            :rows="amendmentRows"
            :document="document"
            :show-position="showPosition"
            :document-path="documentPath"
          />
        </div>

        <!--
          The right column, in view while the left one scrolls; it scrolls
          on its own when its lists, opened, outgrow the screen. The padding
          keeps focus rings unclipped; the margin that offsets it stays off
          the inline end, so the column ends with its track.
        -->
        <div
          v-if="speakers || headcountsDto"
          class="sticky top-0 -my-1 -ms-1 hidden max-h-[calc(100dvh-var(--shell-banner-height,0px)-var(--ui-header-height)-var(--shell-breadcrumb-height,0px)-6rem)] flex-col gap-6 xl:flex overflow-x-hidden overflow-y-auto p-1"
        >
          <LiveViewSpeakers
            v-if="speakers"
            :speakers="speakers"
            heading-id="live-speakers-side-title"
          />
          <LiveViewAttendance
            v-if="headcountsDto"
            :attendance="attendance"
            heading-id="live-attendance-side-title"
          />
        </div>
      </div>
    </template>
  </div>
</template>

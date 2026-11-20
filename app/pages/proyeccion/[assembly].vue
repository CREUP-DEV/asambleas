<script setup lang="ts">
import type {
  AgendaDto,
  AssemblyDto,
  DocumentAmendmentsDto,
  DocumentDto,
  HeadcountsDto,
  LiveEventDto,
  LivePointerDto,
  LiveScrollDto,
  LiveStateDto,
  LiveTally,
  LiveTallyDto,
  SpeakersDto,
  VoteDto,
} from "~~/shared/types/api";
import { errorStatus, useApi } from "~/composables/api/useApi";
import {
  keepLastGoodData,
  onlyForKey,
  useRetryFailed,
} from "~/composables/fetch/lastGoodData";
import { useAssemblyLive } from "~/composables/live/useAssemblyLive";
import { useAppNow } from "~/composables/time/useAppNow";
import {
  buildSessionAgendaRows,
  sessionConnectionState,
} from "~/composables/session/sessionModel";
import { agendaWithTitles } from "~/utils/agendaTitles";
import { formatMoment, formatTime } from "~/utils/format";
import { applyScrollAnchor } from "~/utils/scrollAnchor";
import {
  EMPTY_POINTER_STATE,
  applyPointerEvents,
  type PointerState,
} from "~/composables/session/pointerState";
import { usePointerFade } from "~/composables/session/usePointerFade";
import {
  affectsAgenda,
  affectsLiveVote,
  affectsSpeakers,
  liveAmendmentRows,
  liveAmendmentStats,
  liveAssentKey,
  liveBlocEntries,
  liveSpeakers,
  liveTallyCast,
  liveTallyRows,
  liveTransactedCodes,
  liveVoteCounts,
  liveVoteQuestion,
  liveVoteSubject,
  liveVoteSubjectText,
} from "~/components/live-view/-model";
import {
  affectsHeadcounts,
  liveAttendance,
} from "~/components/live-view/-attendance";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { ROOM_VIEW_QUERY } from "~~/shared/constants/roomView";
import { LIVE_TALLY_TTL_MS } from "~~/shared/utils/schemas/assembly";

/**
 * Projection screen for the room: chrome-free, large type, high contrast.
 * It shows what the Mesa puts in debate (a document with its text or its
 * PDF beside the agenda, an amendment with the blocks it changes, or a bloc
 * of amendments the Mesa proposes to approve together, each turning green
 * as it is approved), the
 * result of the last vote and the Mesa's message; when nothing is in
 * debate, the agenda. While the Mesa makes the speaking turns visible, a
 * band at the bottom shows who has the floor, for how long, and who is
 * next. An amendment on screen takes most of the screen, with the agenda
 * item and the document's amendments in a narrow column beside it. A secret
 * vote the Mesa is counting is announced (what is voted and its question)
 * with its running count or, when the Mesa shows it only at the end, a
 * line saying so. The header also shows the Mesa's latest headcount
 * (members present, quorum and the majorities it gives), for
 * transparency. It follows the live state and is open to every signed-in
 * user.
 *
 * It is opened on a Mesa account but read by the whole room: every read of
 * a Mesa account asks for the room view (`?view=room`), and the server
 * answers as an account that sees only what is public (roomView.ts). The
 * executive offices read as "CEA", nobody speaking for one is named, and
 * unpublished documents, amendments and agenda items stay out, except the
 * agenda item the Mesa itself puts on screen.
 *
 * Nobody watches the projector to reload it, so a failed refresh never
 * wipes the screen: every source keeps its last good data (and the footer
 * says it is not up to date) and is retried on its own until it loads
 * again, and the live stream stays keyed on the assembly id, reconnecting
 * and polling until the server is back.
 */
definePageMeta({ layout: false });

const route = useRoute();
const { t, locale } = useI18n();
const localePath = useLocalePath();
const api = useApi();
const me = useMe();

const param = computed(() => String(route.params.assembly ?? ""));
const assemblyUrl = computed(
  () => `/api/assemblies/${encodeURIComponent(param.value)}`,
);

// Who opened the screen must be known before the first read.
await me.ensure();

/**
 * The room view, for the Mesa's reads (the server honours it only for
 * session:moderate). Anyone else already reads as themselves, which is
 * what they may see. While the account is unknown (/api/me failed) the page
 * asks for it anyway: a Mesa account never reads as itself here, and anyone
 * else gets a 403 until the account loads (then every source reads again).
 */
const roomView = computed(
  () => !me.loaded.value || me.can(PERMISSION_KEYS.SESSION_MODERATE),
);
const viewQuery = computed(() =>
  roomView.value ? { ...ROOM_VIEW_QUERY } : undefined,
);
function read<T>(url: string): Promise<T> {
  return api.get<T>(url, viewQuery.value);
}

/** Gone for this screen: deleted, or not visible to the signed-in user. */
function isGone(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 403 || status === 404;
}

/** A document the screen cannot show means nothing in debate; rethrow the rest. */
function nullIfGone(error: unknown): null {
  if (isGone(error)) return null;
  throw error;
}

// Its own key: the hub's copy of the assembly is the account's, not the room's.
const assemblyFetch = await useFetch<AssemblyDto>(() => assemblyUrl.value, {
  key: computed(() => `projection-assembly-${param.value}`),
  query: viewQuery,
});

// Refused while the account was unknown: try once more as who it is.
if (!assemblyFetch.data.value && !me.loaded.value) {
  await me.refresh();
  if (!roomView.value) await assemblyFetch.refresh();
}
if (!assemblyFetch.data.value) {
  const status = errorStatus(assemblyFetch.error.value) ?? 500;
  throw createError({
    statusCode: status,
    data: status === 404 ? { messageKey: "projection.notFound" } : undefined,
    fatal: true,
  });
}

/** Stable for the whole page: the stream never depends on a refetch. */
const assemblyId = assemblyFetch.data.value.id;

const {
  data: assembly,
  stale: assemblyStale,
  failed: assemblyFailed,
} = keepLastGoodData(assemblyFetch, { isGone });
const refreshAssembly = assemblyFetch.refresh;

const liveFetch = await useAsyncData(
  () => `projection-live-${param.value}`,
  () => read<LiveStateDto>(`${assemblyUrl.value}/live-state`),
);
const {
  data: live,
  stale: liveStale,
  failed: liveFailed,
} = keepLastGoodData(liveFetch, {
  isGone,
});
const refreshLive = liveFetch.refresh;

const agendaFetch = await useAsyncData(
  () => `projection-agenda-${param.value}`,
  () => read<AgendaDto>(`${assemblyUrl.value}/agenda`),
);
const {
  data: fetchedAgenda,
  stale: agendaStale,
  failed: agendaFailed,
} = keepLastGoodData(agendaFetch, {
  isGone,
});
// An item sent without its title gets a neutral one (titleHidden).
const agenda = agendaWithTitles(fetchedAgenda, () => t("agenda.hiddenTitle"));
const refreshAgenda = agendaFetch.refresh;

// Speaking turns. A 404 (no such endpoint, or hidden) shows nothing.
const speakersFetch = await useAsyncData(
  () => `projection-speakers-${param.value}`,
  () => read<SpeakersDto>(`${assemblyUrl.value}/speakers`).catch(nullIfGone),
);
const {
  data: speakersDto,
  stale: speakersStale,
  failed: speakersFailed,
} = keepLastGoodData(speakersFetch, { isGone });
const refreshSpeakers = speakersFetch.refresh;

// The Mesa's headcounts, public. A 404 shows nothing.
const headcountsFetch = await useAsyncData(
  () => `projection-headcounts-${param.value}`,
  () =>
    read<HeadcountsDto>(`${assemblyUrl.value}/headcounts`).catch(nullIfGone),
);
const {
  data: headcountsDto,
  stale: headcountsStale,
  failed: headcountsFailed,
} = keepLastGoodData(headcountsFetch, { isGone });
const refreshHeadcounts = headcountsFetch.refresh;

// From the kept live state, so a failed live-state refresh does not switch
// the document fetches to "none".
const documentId = computed(() => live.value?.documentId ?? null);
const documentUrl = computed(() =>
  documentId.value
    ? `${assemblyUrl.value}/documents/${encodeURIComponent(documentId.value)}`
    : null,
);
const documentFetch = await useAsyncData(
  () => `projection-document-${documentId.value ?? "none"}`,
  () =>
    documentUrl.value
      ? read<DocumentDto>(documentUrl.value).catch(nullIfGone)
      : Promise.resolve(null),
);
// Reset when the Mesa moves to another document: the previous one must not
// stand in for it if its fetch fails.
const {
  data: keptDocument,
  stale: documentStale,
  failed: documentFailed,
} = keepLastGoodData(documentFetch, { isGone, resetOn: documentId });
// Nuxt seeds a new key with the previous document until the new one lands:
// only the document the Mesa has on screen is ever shown under it.
const document = onlyForKey(
  keptDocument,
  () => documentId.value,
  (value) => value.id,
);
/** The Mesa moved to a document still on its way: a skeleton meanwhile. */
const documentLoading = computed(
  () => documentId.value !== null && !document.value && !documentFailed.value,
);
const refreshDocument = documentFetch.refresh;

const amendmentsFetch = await useAsyncData(
  () => `projection-amendments-${documentId.value ?? "none"}`,
  () =>
    documentUrl.value
      ? read<DocumentAmendmentsDto>(`${documentUrl.value}/amendments`).catch(
          nullIfGone,
        )
      : Promise.resolve(null),
);
const {
  data: amendmentsDto,
  stale: amendmentsStale,
  failed: amendmentsFailed,
} = keepLastGoodData(amendmentsFetch, { isGone, resetOn: documentId });
const refreshAmendments = amendmentsFetch.refresh;

/** Some source failed its last refresh and shows its last good data. */
const stale = computed(
  () =>
    assemblyStale.value ||
    liveStale.value ||
    agendaStale.value ||
    documentStale.value ||
    amendmentsStale.value ||
    speakersStale.value ||
    headcountsStale.value,
);

/**
 * Some source failed its last refresh, whether or not it had data to keep
 * (one that never loaded is not `stale`, but it is not up to date either).
 */
const failed = computed(
  () =>
    assemblyFailed.value ||
    liveFailed.value ||
    agendaFailed.value ||
    documentFailed.value ||
    amendmentsFailed.value ||
    speakersFailed.value ||
    headcountsFailed.value,
);

// Live updates -------------------------------------------------------------------

/** When everything was last refreshed successfully. */
const lastUpdate = ref<Date | null>(null);

function onLive(events: LiveEventDto[]): void {
  const refreshes: Promise<unknown>[] = [];
  const poll = events.some((event) => event.type === "poll");
  const current = documentId.value;
  const touches = (types: string[]) =>
    events.some((event) => types.includes(event.entityType));
  const touchesDocument = events.some(
    (event) =>
      current !== null &&
      (event.documentId === current ||
        (event.entityType === "document" && event.entityId === current)),
  );

  // Still unknown after the page opened (/api/me failed): every event or
  // poll tries again, and the sources follow once it loads (roomView).
  if (!me.loaded.value) void me.refresh();
  // The vote on screen may change without the live state moving (its
  // unanimity): its own event reads the live state again.
  if (
    poll ||
    touches(["live"]) ||
    affectsLiveVote(events, live.value?.vote?.id)
  ) {
    refreshes.push(refreshLive());
  }
  if (affectsSpeakers(events)) refreshes.push(refreshSpeakers());
  if (affectsHeadcounts(events)) refreshes.push(refreshHeadcounts());
  // A count's events are lost while the stream is down: a reconnect (its
  // `ready`) and the polling fallback read the kept one again, so a count
  // ended or expired meanwhile leaves the screen.
  if (poll) void readTally();
  if (poll || touches(["assembly"])) refreshes.push(refreshAssembly());
  if (affectsAgenda(events)) refreshes.push(refreshAgenda());
  if (poll || touchesDocument) {
    refreshes.push(refreshDocument(), refreshAmendments());
  }
  // asyncData refreshes resolve even when they fail: only stamp the time
  // when every source is up to date.
  void Promise.all(refreshes).then(() => {
    if (!failed.value) lastUpdate.value = new Date();
  });
}

// Where the Mesa has the document in debate scrolled ----------------------------

/**
 * The projection shows the part of the document the Mesa has in view in
 * its console (user's decision of 2026-11-18): the block or page at the
 * top of the Mesa's box and how far into it, applied to this box whatever
 * its size. Each position arrives on the stream (`scroll`); a projection
 * that opens, or moves to another document, reads the last one.
 */
const documentBox = ref<HTMLElement | null>(null);
const documentContent = ref<HTMLElement | null>(null);
const mesaScroll = ref<LiveScrollDto | null>(null);

/**
 * The Mesa's pointer on the document: the dot, the ripples of a click and
 * the strokes it draws, placed on the same block or page (SessionPointer-
 * Layer), fading as they do on the Mesa's screen. A new document starts
 * clean.
 */
const mesaPointer = shallowRef<PointerState>(EMPTY_POINTER_STATE);

/**
 * A secret vote the Mesa is counting (user's decisions of 2026-11-18 and
 * 2026-11-19): announced once the Mesa picks how the room follows it, with
 * what is voted and its question, and either the count growing ballot by
 * ballot or a line saying the result comes at the end. Each change arrives
 * on the stream (`tally`) until the vote is recorded, when its result takes
 * over. A projection that opens mid-count, or gets its stream back, reads
 * the last one; the server ends a count no console repeats
 * (LIVE_TALLY_TTL_MS), so one left by a closed console does not stay.
 */
const tally = ref<LiveTally | null>(null);
/** Counts the stream's events: a read that one overtook is dropped. */
let tallyEvents = 0;
/** When this page last got a count (its own clock, not the server's). */
let tallySeenAt = 0;
function setTally(next: LiveTally | null): void {
  tally.value = next;
  if (next) tallySeenAt = Date.now();
}
function onTally(dto: LiveTallyDto): void {
  tallyEvents += 1;
  setTally(dto.tally);
}
async function readTally(): Promise<void> {
  const before = tallyEvents;
  try {
    const dto = await read<LiveTallyDto | null>(
      `${assemblyUrl.value}/live-tally`,
    );
    if (tallyEvents === before) setTally(dto?.tally ?? null);
  } catch {
    // The next ballot brings it.
  }
}
onMounted(() => void readTally());
// A count nobody sends again ends here too, should its end never arrive.
useIntervalFn(() => {
  if (tally.value && Date.now() - tallySeenAt > LIVE_TALLY_TTL_MS) {
    tally.value = null;
  }
}, 5_000);
const tallyRows = computed(() => liveTallyRows(tally.value));
const tallyCast = computed(() => liveTallyCast(tally.value));
usePointerFade(mesaPointer);
function onMesaPointer(pointer: LivePointerDto): void {
  if (pointer.documentId !== documentId.value) return;
  mesaPointer.value = applyPointerEvents(
    mesaPointer.value,
    pointer.events,
    Date.now(),
  );
}
watch(documentId, () => {
  mesaPointer.value = EMPTY_POINTER_STATE;
});

function followMesaScroll(): void {
  const scroll = mesaScroll.value;
  const box = documentBox.value;
  if (!scroll || !box || scroll.documentId !== documentId.value) return;
  applyScrollAnchor(box, scroll.anchor);
}

function onMesaScroll(scroll: LiveScrollDto): void {
  mesaScroll.value = scroll;
  followMesaScroll();
}

async function readMesaScroll(): Promise<void> {
  if (!documentId.value) return;
  try {
    const scroll = await read<LiveScrollDto | null>(
      `${assemblyUrl.value}/live-scroll`,
    );
    if (scroll) onMesaScroll(scroll);
  } catch {
    // The next position the Mesa sends puts it right.
  }
}
watch(documentId, () => void readMesaScroll(), { immediate: true });
watch(documentBox, () => followMesaScroll(), { flush: "post" });

const { connected, polling, expired } = useAssemblyLive(
  () => assemblyId,
  onLive,
  {
    onScroll: onMesaScroll,
    onPointer: onMesaPointer,
    onTally,
  },
);

// Until the first connection is ready the screen is connecting, not
// offline: the room must not see an alarm while the page opens.
const everConnected = ref(false);
watch(
  connected,
  (isConnected) => {
    if (isConnected) everConnected.value = true;
  },
  { immediate: true },
);
const connection = computed(() =>
  sessionConnectionState(connected.value, polling.value, everConnected.value),
);
const CONNECTION_DOT = {
  live: "bg-success motion-safe:animate-pulse",
  polling: "bg-warning",
  connecting: "bg-(--ui-text-dimmed)",
  offline: "bg-error",
} as const;
/**
 * Where to sign in again once the session is gone (`expired`), back to the
 * projection afterwards. A full load: its data was read as nobody.
 */
const signInAgainPath = computed(() =>
  localePath({ path: "/login", query: { redirect: route.fullPath } }),
);
const connectionLabel = computed(() => {
  if (expired.value) return t("projection.sessionExpired");
  switch (connection.value) {
    case "live":
      return t("projection.live");
    case "polling":
      return t("projection.polling");
    case "connecting":
      return t("projection.connecting");
    default:
      return t("projection.offline");
  }
});

// Live events only refresh what they touch, and polls only run while the
// stream is down: a refresh that fails while the stream stays up (a 502
// under the refetch herd of a vote) is retried here, with backoff, until it
// succeeds. Independent of live events, so events about other sources never
// postpone it.
useRetryFailed(
  [
    { failed: liveFailed, status: liveFetch.status, refresh: refreshLive },
    {
      failed: assemblyFailed,
      status: assemblyFetch.status,
      refresh: refreshAssembly,
    },
    {
      failed: agendaFailed,
      status: agendaFetch.status,
      refresh: refreshAgenda,
    },
    {
      failed: documentFailed,
      status: documentFetch.status,
      refresh: refreshDocument,
    },
    {
      failed: amendmentsFailed,
      status: amendmentsFetch.status,
      refresh: refreshAmendments,
    },
    {
      failed: speakersFailed,
      status: speakersFetch.status,
      refresh: refreshSpeakers,
    },
    {
      failed: headcountsFailed,
      status: headcountsFetch.status,
      refresh: refreshHeadcounts,
    },
  ],
  {
    // Once the session is gone every retry would only get a 401.
    paused: () => expired.value,
    onRecovered: () => {
      lastUpdate.value = new Date();
    },
  },
);

// The account loaded after the page asked for the room view without it:
// every source reads again as who it is (a 403 counted as gone is never
// retried on its own).
watch(roomView, () => {
  void Promise.all([
    refreshLive(),
    refreshAgenda(),
    refreshSpeakers(),
    refreshHeadcounts(),
    refreshDocument(),
    refreshAmendments(),
  ]);
});

// Derived ------------------------------------------------------------------------

// The app's shared clock: it ticks right after every minute boundary.
const now = useAppNow();

// Only the items with a number: the room view also sends the item the Mesa
// puts on screen when it is not public yet (and the items above it, without
// their titles), and an item that stays without its title. The room never
// reads those, except the one the Mesa itself puts on screen. An account
// that reads as itself (not the Mesa) may also get items not public yet.
const rows = computed(() =>
  buildSessionAgendaRows(
    agenda.value?.items ?? [],
    agenda.value?.documents ?? [],
  ).filter(
    (row) => row.number !== null || row.item.id === live.value?.agendaItemId,
  ),
);
const currentRow = computed(
  () =>
    rows.value.find((row) => row.item.id === live.value?.agendaItemId) ?? null,
);
// The room view gets an item that is not public yet only while the Mesa has
// it on screen, and a change of the live state does not touch the agenda:
// fetch it again when the Mesa puts on screen an item it does not have.
watch(
  () => live.value?.agendaItemId ?? null,
  (id) => {
    if (!roomView.value || !id) return;
    const item = agenda.value?.items.find((entry) => entry.id === id);
    if (!item || item.titleHidden) void refreshAgenda();
  },
);
const amendments = computed(() => amendmentsDto.value?.amendments ?? []);
const debated = computed(() =>
  live.value?.amendmentId
    ? (amendments.value.find((item) => item.id === live.value!.amendmentId) ??
      null)
    : null,
);
const base = computed(() => document.value?.baseVersion?.blocks ?? []);
/** The document's text as the console shows it: voted, or as published. */
const previewBlocks = computed(
  () =>
    document.value?.consolidatedVersion?.blocks ??
    document.value?.baseVersion?.blocks ??
    [],
);
const vote = computed<VoteDto | null>(() => live.value?.vote ?? null);
const message = computed(() => live.value?.message?.trim() || null);

/** A recess the Mesa called: the screen says so until it ends. */
const recess = computed(() => live.value?.recess ?? null);

/**
 * A bloc the Mesa proposes to approve together (user's decision of
 * 2026-11-19): its codes in text order, each with its main author and
 * whether it is approved yet (the amendments refresh on every outcome).
 */
const blocEntries = computed(() =>
  liveBlocEntries(live.value?.amendmentBloc, amendments.value),
);
/** The bloc's amendments, marked in the list beside it. */
const blocIds = computed(
  () => new Set(blocEntries.value.map((entry) => entry.id)),
);
const blocApproved = computed(
  () => blocEntries.value.filter((entry) => entry.approved).length,
);

const mode = computed<"recess" | "amendment" | "bloc" | "document" | "idle">(
  () => {
    if (recess.value) return "recess";
    if (debated.value) return "amendment";
    if (blocEntries.value.length > 0) return "bloc";
    if (document.value || documentLoading.value) return "document";
    return "idle";
  },
);
/**
 * The page takes the screen's height exactly: its boxes scroll themselves
 * (the document, and the agenda beside it or on its own), so a long agenda
 * never pushes the item in debate off the screen.
 */
const fitsScreen = computed(() => mode.value !== "recess");

// Beside a document the agenda keeps to the screen's height: it scrolls
// itself so the item in debate stays in view.
// The item in debate sits in the middle of the agenda whenever the list
// allows it (user's decision of 2026-11-19), so the room sees the items
// before and after it; moving on scrolls there smoothly. Only the list
// scrolls, never the page.
const agendaNav = ref<HTMLElement | null>(null);
/**
 * The document's amendments beside the amendment on screen: the one on
 * screen sits in the middle too.
 */
const amendmentsNav = ref<HTMLElement | null>(null);
/** The lists last placed: a new one (another mode) is placed at once. */
const placed = new WeakSet<HTMLElement>();

/** Scrolls a list so its current row sits in the middle of its box. */
function centerCurrent(box: HTMLElement | null): void {
  // The row on screen, or the first one of a bloc.
  const current = box?.querySelector<HTMLElement>(
    "[aria-current], [data-marked]",
  );
  // Not laid out yet (hidden, or before the first layout): the first
  // placement that counts is the one that can measure, and it jumps.
  if (!box || !current || box.clientHeight === 0) return;
  const boxRect = box.getBoundingClientRect();
  const rect = current.getBoundingClientRect();
  const top =
    rect.top -
    boxRect.top +
    box.scrollTop -
    (box.clientHeight - rect.height) / 2;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  box.scrollTo({
    top: Math.max(0, top),
    // A list placed for the first time (the screen opening, or another
    // mode's list) goes there at once; moving on in it glides.
    behavior: placed.has(box) && !reduce ? "smooth" : "auto",
  });
  placed.add(box);
}

watch(
  () => [live.value?.agendaItemId, agendaNav.value, rows.value.length],
  () => centerCurrent(agendaNav.value),
  { flush: "post" },
);

// An agenda item's vote names the item as the room reads it, from the
// room view's agenda (the item on screen is in it, with its title only
// when the room may read it).
const voteSubjectKind = computed(() =>
  vote.value
    ? liveVoteSubject(vote.value, {
        amendments: amendments.value,
        document: document.value ?? null,
        agenda: rows.value,
      })
    : null,
);
const voteSubject = computed(() =>
  voteSubjectKind.value ? liveVoteSubjectText(voteSubjectKind.value, t) : "",
);
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
/** "Por asentimiento", or "Por unanimidad" when nobody objected. */
const voteAssentKey = computed(() =>
  vote.value ? liveAssentKey(vote.value) : null,
);

const voteCounts = computed(() =>
  vote.value ? liveVoteCounts(vote.value) : [],
);

// A result the Mesa puts on screen ends any count still shown (a console
// closed mid-count never ends its own), once the result is there to take
// its place; the server forgets its copy when it projects a vote it
// records. A console still counting sends it back.
watch(
  () => vote.value?.id ?? null,
  (id, previous) => {
    if (id && id !== previous) tally.value = null;
  },
);

/** What the secret vote being counted is about, as the room reads it. */
const tallySubjectKind = computed(() => {
  const subject = tally.value?.subject;
  return subject
    ? liveVoteSubject(
        { subjectType: subject.type, subjectId: subject.id },
        {
          amendments: amendments.value,
          document: document.value ?? null,
          agenda: rows.value,
        },
      )
    : null;
});
const tallySubject = computed(() =>
  tallySubjectKind.value
    ? liveVoteSubjectText(tallySubjectKind.value, t)
    : null,
);
/**
 * Its question, unless the heading already says it or the room reads the
 * item without its title (the server drops it then too).
 */
const tallyQuestion = computed(() => {
  const value = tally.value;
  if (!value?.question) return null;
  const subject = value.subject;
  if (subject?.type === "agenda_item") {
    const row = rows.value.find((entry) => entry.item.id === subject.id);
    if (!row || row.item.titleHidden) return null;
  }
  return liveVoteQuestion(
    value,
    tallySubjectKind.value ?? { kind: "other" },
    t("agenda.unlisted.inText"),
  );
});

/** The Mesa's latest headcount and the majorities it gives. */
const attendance = computed(() =>
  liveAttendance(headcountsDto.value, {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...assembly.value?.settings,
  }),
);
const attendanceLine = computed(() => {
  const value = attendance.value;
  if (!value || assembly.value?.status !== "in_session") return null;
  const parts: string[] = [];
  // A count from another day (Europe/Madrid) says when it was taken: its
  // majorities may no longer match the room.
  const taken = formatMoment(value.latest.takenAt, {
    locale: locale.value,
    now: now.value,
  });
  // Worded as the final vote's dialog words it (session.vote.countMoment),
  // with "ayer, 18:45" or "16 nov 2026, 18:45" from formatMoment.
  if (!taken.today && taken.text) {
    parts.push(t("session.vote.countMoment", { moment: taken.text }));
  }
  parts.push(
    t("projection.attendance.present", {
      present: value.latest.present,
      eligible: value.latest.eligible,
    }),
    value.latest.quorum
      ? t("session.headcount.quorum")
      : t("session.headcount.noQuorum"),
  );
  if (value.majorities) {
    parts.push(
      t("projection.attendance.absolute", {
        count: value.majorities.absolute,
      }),
      t("projection.attendance.twoThirds", {
        count: value.majorities.twoThirds,
      }),
    );
  }
  return parts.join(" · ");
});

/** Who has the floor and who is next, only while the Mesa shows it. */
const speakers = computed(() =>
  liveSpeakers(speakersDto.value, live.value?.speakersVisible ?? false),
);
/**
 * The document's amendments beside the amendment on screen, in the order
 * attendees read them (liveAmendmentRows: published ones only), the one on
 * screen highlighted (user's decision of 2026-11-20).
 */
const amendmentRows = computed(() =>
  liveAmendmentRows(amendments.value, debated.value?.id ?? null, {
    byAnswer: true,
  }),
);
watch(
  () => [
    debated.value?.id,
    blocEntries.value[0]?.id,
    amendmentsNav.value,
    amendmentRows.value.length,
  ],
  () => centerCurrent(amendmentsNav.value),
  { flush: "post" },
);
// Its box changes size with the screen, and the text font may land after
// the first layout: the one on screen goes back to the middle.
useResizeObserver(amendmentsNav, () => centerCurrent(amendmentsNav.value));
onMounted(() => {
  void window.document.fonts?.ready.then(() =>
    centerCurrent(amendmentsNav.value),
  );
});

/** "E3 y E5": the locale's own way of joining a list. */
function joinCodes(codes: string[]): string {
  try {
    return new Intl.ListFormat(locale.value, {
      style: "long",
      type: "conjunction",
    }).format(codes);
  } catch {
    return codes.join(", ");
  }
}
/** A transactional on screen names the amendments it combines. */
const transacted = computed(() => {
  const codes = debated.value
    ? liveTransactedCodes(debated.value, amendments.value)
    : [];
  return codes.length > 0
    ? t("projection.transacts", { codes: joinCodes(codes) }, codes.length)
    : null;
});

// Only what the room can read. The room view already gets published
// amendments only; liveAmendmentRows keeps to them for an account that
// reads as itself (an author also gets its own unpublished ones).
const amendmentStats = computed(() =>
  liveAmendmentStats(liveAmendmentRows(amendments.value, null)),
);

// The amendment on screen ------------------------------------------------------

/**
 * Nobody scrolls a projector. The diff shows only the blocks the amendment
 * changes, in a box that fills what the vote, the message and the speakers
 * leave: its text shrinks until it fits (down to a readable minimum, set in
 * the styles), and whenever the amendment, its text or the room left for it
 * changes, the box scrolls to the first change, so the room always sees
 * what is debated even when it does not fit whole.
 */
const diffBox = ref<HTMLElement | null>(null);

/** Text scales tried, from the full size down; the CSS floor stops it. */
const FIT_MIN = 0.4;
const FIT_STEPS = 7;

/** What an amendment changes, in the order of the text. */
const CHANGE_SELECTOR =
  ".cx-ins, .cx-del, .cx-fmt, .cx-fmt-label, .cx-block-inserted, .cx-block-deleted";

function overflows(box: HTMLElement): boolean {
  return box.scrollHeight > box.clientHeight + 1;
}

/** The largest text scale that fits the box, by bisection. */
function fitDiff(box: HTMLElement): void {
  box.style.setProperty("--projection-fit", "1");
  if (!overflows(box)) return;
  let fits = FIT_MIN;
  let tooBig = 1;
  for (let step = 0; step < FIT_STEPS; step++) {
    const middle = (fits + tooBig) / 2;
    box.style.setProperty("--projection-fit", String(middle));
    if (overflows(box)) tooBig = middle;
    else fits = middle;
  }
  box.style.setProperty("--projection-fit", String(fits));
}

/**
 * Scrolls the box to the first change: to the start of its block when the
 * change shows with it, else to the change itself, a line and a half
 * below the top. Format-only changes count (their mark or their note).
 */
function scrollToFirstChange(box: HTMLElement): void {
  if (!overflows(box)) {
    box.scrollTop = 0;
    return;
  }
  const change =
    box.querySelector<HTMLElement>(CHANGE_SELECTOR) ??
    box.querySelector<HTMLElement>("[data-block-id]");
  if (!change) return;
  const block = change.closest<HTMLElement>("[data-block-id]") ?? change;
  const anchor = change.classList.contains("cx-fmt-label") ? block : change;
  const boxTop = box.getBoundingClientRect().top - box.scrollTop;
  const style = getComputedStyle(box);
  const padding = Number.parseFloat(style.paddingTop) || 0;
  const line =
    Number.parseFloat(getComputedStyle(anchor).lineHeight) ||
    Number.parseFloat(getComputedStyle(anchor).fontSize) * 1.5 ||
    0;
  const blockTop = block.getBoundingClientRect().top - boxTop - padding;
  const anchorTop = anchor.getBoundingClientRect().top - boxTop;
  const top =
    anchorTop + line * 2 - blockTop <= box.clientHeight
      ? blockTop
      : anchorTop - line * 1.5;
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  box.scrollTo({
    top: Math.max(0, top),
    behavior: reduceMotion ? "auto" : "smooth",
  });
}

let layoutFrame = 0;
function layoutDiff(): void {
  if (!import.meta.client || layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    const box = diffBox.value;
    if (!box) return;
    fitDiff(box);
    scrollToFirstChange(box);
  });
}

// The amendment, its text or the base it applies to changed: the DOM is
// up to date once a post-flush watcher runs.
watch(
  () => [debated.value?.id, debated.value?.ops, base.value, diffBox.value],
  layoutDiff,
  { flush: "post" },
);
// The room left for it changed: a vote, the message or the speakers came
// or went, or the window was resized.
useResizeObserver(diffBox, layoutDiff);

/**
 * A bloc's chips shrink together until every one fits (user's decision of
 * 2026-11-20), as the amendment's text does (fitDiff, same floor).
 */
const blocBox = ref<HTMLElement | null>(null);
let blocFrame = 0;
function layoutBloc(): void {
  if (!import.meta.client || blocFrame) return;
  blocFrame = requestAnimationFrame(() => {
    blocFrame = 0;
    if (blocBox.value) fitDiff(blocBox.value);
  });
}
watch(
  () => [
    blocEntries.value.map((entry) => `${entry.id}:${entry.approved}`).join(),
    blocBox.value,
  ],
  layoutBloc,
  { flush: "post" },
);
useResizeObserver(blocBox, layoutBloc);
// The content font (Raleway or the reader's preference) may land after the
// first layout and change the height of the text.
onMounted(() => {
  void window.document.fonts?.ready.then(() => {
    layoutDiff();
    layoutBloc();
  });
});
onBeforeUnmount(() => {
  if (layoutFrame) cancelAnimationFrame(layoutFrame);
});

// Clock and fullscreen -----------------------------------------------------------

const clock = computed(() => formatTime(now.value, { locale: locale.value }));

/** "17:30", or with its day when it is not today. */
const recessResumes = computed(() => {
  const until = recess.value?.until;
  return until
    ? formatMoment(until, { locale: locale.value, now: now.value }).text
    : null;
});
/**
 * The minutes left, whole and never more than are left (the shared clock
 * ticks each minute); once the time comes, that it resumes shortly.
 */
const recessLeft = computed(() => {
  const until = recess.value?.until;
  if (!until) return null;
  const left = new Date(until).getTime() - now.value;
  if (left <= 60_000) return t("projection.recess.soon");
  const minutes = Math.floor(left / 60_000);
  return t("projection.recess.minutesLeft", { count: minutes }, minutes);
});

const {
  isFullscreen,
  isSupported: fullscreenSupported,
  toggle: toggleFullscreen,
} = useFullscreen();
/**
 * Full screen in or out, and the button lets the focus go: the projector
 * would otherwise show its focus ring over the room until someone clicks
 * elsewhere.
 */
function onFullscreenClick(event: MouseEvent): void {
  void toggleFullscreen();
  (event.currentTarget as HTMLElement | null)?.blur();
}

useHead(() => ({
  title: t("projection.pageTitle", { label: assembly.value?.label ?? "" }),
}));
</script>

<template>
  <div
    class="projection bg-default text-highlighted flex flex-col font-sans"
    :class="fitsScreen ? 'h-dvh' : 'min-h-dvh'"
  >
    <!-- An amendment or a document fits the screen (its box scrolls
         itself): the page then takes the screen's height exactly. -->
    <header
      class="border-default flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-[clamp(1rem,3vw,3rem)] py-[clamp(0.5rem,1vw,1rem)]"
    >
      <img
        src="/marca/vertical-granate.svg"
        :alt="t('projection.logo')"
        class="projection-logo dark:hidden"
      />
      <img
        src="/marca/vertical-beige.svg"
        :alt="t('projection.logo')"
        class="projection-logo hidden dark:block"
      />
      <div class="min-w-0 flex-1">
        <p class="text-[clamp(1.25rem,2vw,2.25rem)] leading-tight font-bold">
          {{ assembly?.label }}
        </p>
        <!-- An amendment or a bloc on a narrow screen: otherwise the column
             beside it names the item. -->
        <p
          v-if="currentRow && (mode === 'amendment' || mode === 'bloc')"
          class="text-muted truncate text-[clamp(1rem,1.4vw,1.5rem)] lg:hidden"
        >
          <AgendaItemNumber :number="currentRow.number" />
          {{ currentRow.item.title }}
        </p>
      </div>
      <p
        v-if="attendanceLine"
        class="text-default flex items-center gap-2 text-[clamp(1rem,1.4vw,1.5rem)] font-medium tabular-nums"
      >
        <UIcon
          :name="
            attendance?.latest.quorum
              ? 'i-lucide-users-round'
              : 'i-lucide-user-round-x'
          "
          class="size-[1.2em] shrink-0"
          :class="attendance?.latest.quorum ? 'text-success' : 'text-error'"
          aria-hidden="true"
        />
        <!-- Trimmed to the capitals, as the clock is: both centre on the
             same line, whatever their sizes. -->
        <span class="[text-box:trim-both_cap_alphabetic]">
          {{ attendanceLine }}
        </span>
      </p>
      <div class="flex items-center">
        <!-- Fullscreen support is only known in the browser. -->
        <ClientOnly>
          <!-- The connection, a dot by the clock (the bottom bar is gone so
               the text takes its room); a warning only when it matters.
               The status is always there (its label is for screen
               readers) and takes room only with a warning. -->
          <span
            class="inline-flex items-center gap-2 text-sm has-[.text-warning]:me-3"
            role="status"
          >
            <span class="sr-only">{{ connectionLabel }}</span>
            <ULink
              v-if="expired"
              :to="signInAgainPath"
              external
              class="text-warning font-medium underline underline-offset-4"
            >
              {{ t("projection.sessionExpired") }}
            </ULink>
            <span v-else-if="stale" class="text-warning font-medium">
              {{ t("projection.stale") }}
            </span>
            <span v-else-if="failed" class="text-warning font-medium">
              {{ t("projection.loadFailed") }}
            </span>
          </span>
          <!-- The dot is sized on the clock and centred on its digits: the
               clock's box is trimmed to the capitals (lining figures), so
               items-center needs no nudge (Firefox ignores the trim and
               centres it on the line box). -->
          <span
            class="inline-flex items-center gap-[0.3em] text-[clamp(1.25rem,2vw,2.25rem)] font-semibold"
            :title="connectionLabel"
          >
            <span
              class="size-[0.33em] shrink-0 rounded-full"
              :class="CONNECTION_DOT[connection]"
              aria-hidden="true"
            />
            <span
              class="tabular-nums [text-box:trim-both_cap_alphabetic]"
              :aria-label="t('projection.clock', { time: clock })"
            >
              {{ clock }}
            </span>
          </span>
          <UButton
            v-if="fullscreenSupported"
            class="ms-3"
            color="neutral"
            variant="ghost"
            size="lg"
            :icon="isFullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'"
            :aria-label="
              isFullscreen
                ? t('projection.exitFullscreen')
                : t('projection.fullscreen')
            "
            @click="onFullscreenClick"
          />
        </ClientOnly>
      </div>
    </header>

    <!-- Fitted to the screen, the content starts closer to the header:
         the document's text or PDF takes that room. -->
    <main
      class="flex flex-1 flex-col gap-[clamp(1rem,2vw,2rem)] px-[clamp(1rem,3vw,3rem)] pb-[clamp(1rem,2vw,2rem)] text-[clamp(1.125rem,1.5vw,2rem)]"
      :class="
        fitsScreen
          ? 'min-h-0 pt-[clamp(0.5rem,1vw,1rem)]'
          : 'pt-[clamp(1rem,2vw,2rem)]'
      "
    >
      <!-- A secret vote being counted: what is voted, its question, and
           the count growing ballot by ballot or a line saying the result
           comes at the end. -->
      <section
        v-if="tally && mode !== 'recess'"
        role="status"
        aria-live="polite"
        class="border-primary/50 bg-primary/5 rounded-2xl border-4 px-[clamp(1rem,2.5vw,2.5rem)] py-[clamp(0.75rem,2vw,2rem)]"
      >
        <p
          class="text-muted flex items-center gap-2 text-[clamp(1rem,1.4vw,1.5rem)] font-medium"
        >
          <span
            class="bg-error size-[0.6em] rounded-full motion-safe:animate-pulse"
            aria-hidden="true"
          />
          {{ t("projection.tally.title") }}
        </p>
        <p
          v-if="tallySubject"
          class="text-highlighted mt-1 text-[clamp(1.5rem,3vw,3.25rem)] leading-tight font-extrabold tracking-tight"
        >
          {{ tallySubject }}
        </p>
        <p
          v-if="tallyQuestion"
          class="text-highlighted mt-1 text-[clamp(1.25rem,2.4vw,2.75rem)] leading-snug font-semibold whitespace-pre-line"
        >
          {{ tallyQuestion }}
        </p>
        <dl
          v-if="tally.counts"
          class="mt-[clamp(0.5rem,1vw,1rem)] grid grid-cols-2 gap-x-[clamp(1rem,3vw,3rem)] gap-y-[clamp(0.5rem,1vw,1rem)] lg:grid-cols-4"
        >
          <div v-for="row in tallyRows" :key="row.key" class="min-w-0">
            <dt class="text-muted text-[clamp(0.875rem,1.2vw,1.375rem)]">
              {{ t(`projection.vote.${row.key}`) }}
            </dt>
            <dd
              class="text-[clamp(2.25rem,4.5vw,4.75rem)] leading-tight font-extrabold tabular-nums"
            >
              {{ row.count }}
            </dd>
            <div
              class="bg-elevated h-[clamp(0.4rem,0.6vw,0.75rem)] overflow-hidden rounded-full"
              aria-hidden="true"
            >
              <div
                class="h-full rounded-full transition-[width] duration-300"
                :class="
                  row.key === 'inFavor'
                    ? 'bg-success'
                    : row.key === 'against'
                      ? 'bg-error'
                      : 'bg-(--ui-text-dimmed)'
                "
                :style="{ width: `${row.share * 100}%` }"
              />
            </div>
          </div>
        </dl>
        <p
          v-if="tally.counts"
          class="text-default mt-[clamp(0.5rem,1vw,1rem)] text-[clamp(1rem,1.6vw,1.75rem)] tabular-nums"
        >
          {{
            tally.present !== null
              ? t("projection.tally.castOf", {
                  count: tallyCast,
                  present: tally.present,
                })
              : t("projection.tally.cast", { count: tallyCast }, tallyCast)
          }}
          · {{ t(`session.enums.majority.${tally.majority}`) }}
        </p>
        <p
          v-else
          class="text-default mt-[clamp(0.5rem,1vw,1rem)] text-[clamp(1.125rem,1.8vw,2rem)] font-medium"
        >
          {{ t("projection.tally.revealAtEnd") }}
          · {{ t(`session.enums.majority.${tally.majority}`) }}
        </p>
      </section>

      <section
        v-else-if="vote && mode !== 'recess'"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        class="rounded-2xl border-4 px-[clamp(1rem,2.5vw,2.5rem)] py-[clamp(0.75rem,2vw,2rem)]"
        :class="
          vote.result === 'approved'
            ? 'border-success bg-success/10'
            : 'border-error bg-error/10'
        "
      >
        <p class="text-muted text-[clamp(1rem,1.4vw,1.5rem)] font-medium">
          {{ voteSubject }}
        </p>
        <p
          v-if="voteQuestion"
          class="text-highlighted mt-1 text-[clamp(1.125rem,1.8vw,2rem)] leading-snug font-semibold whitespace-pre-line"
        >
          {{ voteQuestion }}
        </p>
        <p
          class="text-[clamp(2.25rem,5vw,5.5rem)] leading-none font-extrabold tracking-tight uppercase"
          :class="
            vote.result === 'approved'
              ? 'text-(--ui-color-success-800) dark:text-(--ui-color-success-300)'
              : 'text-(--ui-color-error-700) dark:text-(--ui-color-error-300)'
          "
        >
          {{
            vote.result === "approved"
              ? t("projection.vote.approved")
              : t("projection.vote.rejected")
          }}
        </p>
        <p
          v-if="voteAssentKey"
          class="mt-[clamp(0.5rem,1vw,1rem)] text-[clamp(1.25rem,2vw,2.25rem)] leading-tight font-semibold"
        >
          {{ t(voteAssentKey) }}
        </p>
        <dl
          v-else
          class="mt-[clamp(0.5rem,1vw,1rem)] flex flex-wrap gap-x-[clamp(1.5rem,3vw,3rem)] gap-y-2"
        >
          <div v-for="count in voteCounts" :key="count.key">
            <dt class="text-muted text-[clamp(0.875rem,1.2vw,1.375rem)]">
              {{ t(`projection.vote.${count.key}`) }}
            </dt>
            <dd
              class="text-[clamp(1.75rem,3.5vw,3.75rem)] leading-tight font-bold tabular-nums"
            >
              {{ count.value }}
            </dd>
          </div>
          <div>
            <dt class="text-muted text-[clamp(0.875rem,1.2vw,1.375rem)]">
              {{ t("projection.vote.majority") }}
            </dt>
            <dd
              class="text-[clamp(1.25rem,2vw,2.25rem)] leading-tight font-semibold"
            >
              {{ t(`session.enums.majority.${vote.majority}`) }}
            </dd>
          </div>
        </dl>
      </section>

      <section
        v-if="message"
        aria-live="polite"
        class="border-secondary bg-secondary/10 rounded-2xl border-l-8 px-[clamp(1rem,2vw,2rem)] py-[clamp(0.75rem,1.5vw,1.5rem)]"
      >
        <p
          class="text-[clamp(1.25rem,2.2vw,2.75rem)] font-semibold whitespace-pre-line"
        >
          {{ message }}
        </p>
      </section>

      <!-- A recess takes the whole screen: when the session resumes. -->
      <section
        v-if="mode === 'recess' && recess"
        class="flex flex-1 flex-col items-center justify-center gap-[clamp(0.75rem,1.5vw,1.5rem)] text-center"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <UIcon
          name="i-lucide-coffee"
          class="text-primary size-[clamp(3rem,6vw,6rem)]"
          aria-hidden="true"
        />
        <h1
          class="text-[clamp(3rem,7vw,7.5rem)] leading-none font-extrabold tracking-tight"
        >
          {{ t("projection.recess.title") }}
        </h1>
        <p
          v-if="recessResumes"
          class="text-[clamp(1.5rem,3vw,3.25rem)] leading-tight font-semibold tabular-nums"
        >
          {{ t("projection.recess.resumesAt", { time: recessResumes }) }}
        </p>
        <p
          v-if="recessLeft"
          class="text-muted text-[clamp(1.25rem,2vw,2.25rem)] tabular-nums"
        >
          {{ recessLeft }}
        </p>
      </section>

      <!-- An amendment, or a bloc of them, takes most of the screen; beside
           it, a narrow column names the agenda item, counts and lists the
           document's amendments: the one on screen highlighted, or those
           of the bloc marked (user's decisions of 2026-11-20). -->
      <section
        v-else-if="(mode === 'amendment' && debated) || mode === 'bloc'"
        class="grid min-h-0 flex-1 gap-[clamp(1rem,2.5vw,2.5rem)] lg:grid-cols-[minmax(0,1fr)_clamp(15rem,21vw,26rem)]"
      >
        <div
          v-if="mode === 'amendment' && debated"
          class="flex min-h-0 flex-col gap-[clamp(0.75rem,1.5vw,1.5rem)]"
          aria-live="polite"
        >
          <div class="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div class="min-w-0">
              <h1
                id="projection-amendment-title"
                class="text-[clamp(2.25rem,4.5vw,5rem)] leading-none font-extrabold tracking-tight"
              >
                {{ t("projection.amendment", { code: debated.code ?? "" }) }}
              </h1>
              <p
                v-if="transacted"
                class="text-default mt-[clamp(0.25rem,0.6vw,0.6rem)] text-[clamp(1.25rem,2vw,2rem)] leading-tight font-semibold"
              >
                {{ transacted }}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2 pb-1">
              <CommonMemberBadge
                v-for="author in debated.authors"
                :key="author.id"
                :member="author"
                size="xl"
                :tooltip="false"
                show-name
              />
              <CommonStatusBadge
                v-if="debated.status !== 'submitted'"
                kind="amendment"
                :value="debated.status"
                size="xl"
                variant="solid"
              />
            </div>
          </div>
          <!-- Only the blocks it changes: context would push the change off
               the screen (see "The amendment on screen"). -->
          <!-- Focusable: a keyboard reads what does not fit (the room never
               scrolls it; the page brings the change into view). -->
          <div
            ref="diffBox"
            role="region"
            tabindex="0"
            aria-labelledby="projection-amendment-title"
            class="projection-text projection-scroll border-default focus-visible:outline-primary min-h-0 flex-1 overflow-y-auto rounded-2xl border p-[clamp(1rem,2.5vw,2.5rem)] focus-visible:outline-2"
          >
            <ContentAmendmentDiff
              :id="debated.id"
              :base="base"
              :ops="debated.ops"
              :context="0"
            />
          </div>
        </div>
        <!-- A bloc: the codes, large, each with its main author (and what a
             transactional transacts); each turns green as it is approved. -->
        <div
          v-else
          class="flex min-h-0 flex-col gap-[clamp(0.75rem,1.5vw,1.5rem)]"
          aria-live="polite"
        >
          <div class="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div class="min-w-0">
              <h1
                id="projection-bloc-title"
                class="text-[clamp(2.25rem,4.5vw,5rem)] leading-none font-extrabold tracking-tight"
              >
                {{ t("projection.bloc.title") }}
              </h1>
            </div>
            <p
              class="text-default pb-1 text-[clamp(1.25rem,2vw,2rem)] font-semibold tabular-nums"
            >
              {{
                t("projection.bloc.progress", {
                  approved: blocApproved,
                  total: blocEntries.length,
                })
              }}
            </p>
          </div>
          <!-- Every chip fits: they shrink together (blocBox, fitDiff) down
               to a readable floor, and only past it does the list scroll. -->
          <ul
            ref="blocBox"
            class="projection-bloc projection-scroll flex min-h-0 flex-1 flex-wrap content-start gap-[0.75em] overflow-y-auto"
            aria-labelledby="projection-bloc-title"
          >
            <li
              v-for="entry in blocEntries"
              :key="entry.id"
              class="flex min-w-[6em] flex-col gap-[0.25em] rounded-2xl border-4 px-[1em] py-[0.5em] transition-colors duration-300"
              :class="
                entry.approved
                  ? 'border-success bg-success/10'
                  : entry.settled
                    ? 'border-default opacity-60'
                    : 'border-default bg-elevated/40'
              "
            >
              <span
                class="flex items-center gap-[0.3em] text-[2.4em] leading-none font-extrabold tabular-nums"
              >
                <UIcon
                  v-if="entry.approved"
                  name="i-lucide-check"
                  class="text-success size-[0.8em] shrink-0"
                  aria-hidden="true"
                />
                {{ entry.code }}
              </span>
              <span
                v-if="entry.author"
                class="text-muted text-[1.05em] leading-tight font-semibold"
              >
                {{ entry.author.acronym }}
              </span>
              <!-- A transactional says which ones it transacts. -->
              <span
                v-if="entry.transacts.length > 0"
                class="text-default flex items-center gap-[0.3em] text-[0.95em] leading-tight font-semibold"
              >
                <UIcon
                  name="i-lucide-git-merge"
                  class="size-[1em] shrink-0"
                  aria-hidden="true"
                />
                <span class="sr-only">{{
                  t("projection.bloc.transacts")
                }}</span>
                {{ entry.transacts.join(" · ") }}
              </span>
              <span
                v-if="entry.approved"
                class="text-[0.85em] font-bold text-(--ui-color-success-800) uppercase dark:text-(--ui-color-success-300)"
              >
                {{ t("projection.bloc.approved") }}
              </span>
            </li>
          </ul>
        </div>
        <aside
          :aria-label="t('projection.amendments')"
          class="hidden min-h-0 flex-col gap-[clamp(0.5rem,1vw,1rem)] lg:flex"
        >
          <div class="space-y-1 px-4">
            <p
              v-if="currentRow"
              class="text-highlighted text-[clamp(1.125rem,1.6vw,1.75rem)] leading-tight font-bold"
            >
              <AgendaItemNumber :number="currentRow.number" />
              {{ currentRow.item.title }}
            </p>
            <p
              v-if="amendmentStats.total > 0"
              class="text-default text-[clamp(1rem,1.3vw,1.5rem)] tabular-nums"
            >
              {{
                t("projection.amendmentsCompact", {
                  approved: amendmentStats.approved,
                  undecided: amendmentStats.undecided,
                })
              }}
            </p>
          </div>
          <nav
            ref="amendmentsNav"
            :aria-label="t('projection.amendments')"
            class="projection-scroll min-h-0 flex-1 overflow-y-auto"
          >
            <SessionProjectionAmendments
              :rows="amendmentRows"
              :marked="mode === 'bloc' ? blocIds : undefined"
            />
          </nav>
        </aside>
      </section>

      <section
        v-else-if="mode === 'document' && documentLoading"
        class="grid min-h-0 flex-1 gap-[clamp(1rem,3vw,3rem)] lg:grid-cols-[3fr_2fr]"
      >
        <!-- The document the Mesa just put on screen, on its way. -->
        <div
          class="projection-document border-default min-h-0 flex-1 overflow-hidden rounded-2xl border p-[clamp(1rem,2.5vw,2.5rem)]"
        >
          <CommonDocumentSkeleton :paragraphs="4" />
        </div>
        <nav
          :aria-label="t('projection.agenda')"
          class="projection-scroll hidden min-h-0 overflow-y-auto lg:block"
        >
          <SessionProjectionAgenda
            :rows="rows"
            :current-id="live?.agendaItemId ?? null"
            size="compact"
          />
        </nav>
      </section>

      <section
        v-else-if="mode === 'document' && document"
        class="grid min-h-0 flex-1 gap-[clamp(1rem,3vw,3rem)] lg:grid-cols-[3fr_2fr]"
      >
        <div class="flex min-h-0 flex-col">
          <!-- What changes is announced; the text below is not. Always
               there (a live region added with its content may go unread),
               it takes room under it only when a line shows: otherwise
               the text or the PDF starts at the top. -->
          <div
            class="flex flex-col gap-[clamp(0.5rem,1vw,1rem)] has-[p]:mb-[clamp(0.75rem,1.5vw,1.5rem)]"
            aria-live="polite"
          >
            <!-- The agenda beside it already names the document: its title
                 stays for screen readers, and the text takes the room. -->
            <h1 id="projection-document-title" class="sr-only">
              {{ document.title }}
            </h1>
            <p v-if="live?.amendmentId && !debated" class="text-muted">
              {{ t("projection.amendmentHidden") }}
            </p>
            <p
              v-if="document.amendable && amendmentStats.total > 0"
              class="text-default text-[clamp(1.125rem,1.6vw,1.75rem)] tabular-nums"
            >
              {{
                t("projection.amendmentStats", {
                  approved: amendmentStats.approved,
                  undecided: amendmentStats.undecided,
                  total: amendmentStats.total,
                })
              }}
            </p>
            <p
              v-if="document.finalVote"
              class="text-[clamp(1.125rem,1.8vw,2rem)] font-bold"
              :class="
                document.finalVote.result === 'approved'
                  ? 'text-(--ui-color-success-800) dark:text-(--ui-color-success-300)'
                  : 'text-(--ui-color-error-700) dark:text-(--ui-color-error-300)'
              "
            >
              {{
                document.finalVote.result === "approved"
                  ? t("projection.finalApproved")
                  : t("projection.finalRejected")
              }}
            </p>
          </div>
          <!-- The document itself, filling what is left: its PDF drawn page
               by page, its text otherwise. It follows where the Mesa has it
               scrolled in the console (followMesaScroll); a new document
               starts at the top (keyed). -->
          <template v-if="document.format === 'file'">
            <div
              v-if="document.fileUrl"
              :key="document.id"
              ref="documentBox"
              class="projection-scroll border-default bg-elevated min-h-0 flex-1 overflow-y-auto rounded-2xl border p-[clamp(0.25rem,0.5vw,0.5rem)]"
            >
              <div ref="documentContent" class="relative">
                <DocumentPdfPages
                  :url="document.fileUrl"
                  :title="document.title"
                  :text-layer="false"
                  @ready="followMesaScroll"
                />
                <SessionPointerLayer
                  :state="mesaPointer"
                  :scope="documentContent"
                />
              </div>
            </div>
            <p v-else class="text-muted">
              {{ t("projection.pdfPending") }}
            </p>
          </template>
          <div
            v-else-if="previewBlocks.length > 0"
            :key="document.id"
            ref="documentBox"
            role="region"
            tabindex="0"
            :aria-label="
              t('projection.documentText', { title: document.title })
            "
            class="projection-document projection-scroll border-default focus-visible:outline-primary min-h-0 flex-1 overflow-y-auto rounded-2xl border p-[clamp(1rem,2.5vw,2.5rem)] focus-visible:outline-2"
          >
            <div ref="documentContent" class="relative">
              <ContentView :blocks="previewBlocks" />
              <SessionPointerLayer
                :state="mesaPointer"
                :scope="documentContent"
              />
            </div>
          </div>
        </div>
        <nav
          ref="agendaNav"
          :aria-label="t('projection.agenda')"
          class="projection-scroll hidden min-h-0 overflow-y-auto lg:block"
        >
          <SessionProjectionAgenda
            :rows="rows"
            :current-id="live?.agendaItemId ?? null"
            size="compact"
          />
        </nav>
      </section>

      <section
        v-else
        class="flex min-h-0 flex-1 flex-col gap-[clamp(1rem,2vw,2rem)]"
      >
        <h1 class="text-[clamp(2rem,4vw,4.5rem)] leading-tight font-extrabold">
          {{ t("projection.agenda") }}
        </h1>
        <!-- An agenda that never loaded is not an empty agenda -->
        <p v-if="rows.length === 0" class="text-muted">
          {{ agenda ? t("projection.agendaEmpty") : t("agenda.loadError") }}
        </p>
        <!-- Its own box at the screen's height, the item in debate in the
             middle: a long agenda never runs off the screen. -->
        <nav
          v-else
          ref="agendaNav"
          :aria-label="t('projection.agenda')"
          class="projection-scroll min-h-0 flex-1 overflow-y-auto"
        >
          <SessionProjectionAgenda
            :rows="rows"
            :current-id="live?.agendaItemId ?? null"
          />
        </nav>
      </section>
      <!--
        Nobody scrolls a projector: the band sticks to the bottom of the
        screen when a long agenda overflows it (an amendment's diff fits in
        its own box above it). The opaque wrapper hides the text scrolling
        behind the translucent band. Nobody speaking nor waiting leaves it
        out: the document and the agenda take that room.
      -->
      <div
        v-if="
          mode !== 'recess' &&
          speakers &&
          (speakers.current || speakers.next.length > 0)
        "
        class="bg-default sticky bottom-0 z-10 mt-auto pt-2 pb-[clamp(0.25rem,0.5vw,0.5rem)]"
      >
        <LiveViewSpeakers
          :speakers="speakers"
          size="projection"
          heading-id="projection-speakers-title"
        />
      </div>
    </main>
  </div>
</template>

<style scoped>
/*
 * --projection-fit shrinks the text until the amendment fits its box
 * (fitDiff), never below the readable floor; past it, the box scrolls to
 * the first change.
 */
/*
 * A bloc's chips are sized in em on this: every chip shrinks together
 * until they all fit (layoutBloc), never below a readable floor.
 */
.projection-bloc {
  font-size: max(
    0.75rem,
    calc(clamp(1rem, 1.6vw, 1.875rem) * var(--projection-fit, 1))
  );
}

.projection-text :deep(.rich-text) {
  font-size: max(
    1.375rem,
    calc(clamp(1.375rem, 2.3vw, 3rem) * var(--projection-fit, 1))
  );
  line-height: 1.55;
}

/* The page or the Mesa scrolls these boxes: a scrollbar on the projector is noise. */
.projection-scroll {
  scrollbar-width: none;
}

.projection-scroll::-webkit-scrollbar {
  display: none;
}

/*
 * The vertical logo, as tall as the two lines beside it; its drawing keeps
 * a margin inside the square, which the negative margins give back.
 */
.projection-logo {
  /* The vertical logos are trimmed to their drawing: about two lines of
     the assembly's label, so the header takes no more than its text. */
  height: clamp(2.5rem, 4vw, 4.25rem);
  width: auto;
}

/* A whole document never fits: one readable size, and the box scrolls. */
.projection-document :deep(.rich-text) {
  font-size: clamp(1.125rem, 1.6vw, 2rem);
  line-height: 1.55;
}

.projection-text :deep(.rich-text p + p),
.projection-text :deep(.rich-text > * + *) {
  margin-top: 0.9em;
}

.projection-text :deep(.rich-text h2),
.projection-text :deep(.rich-text .cx-heading-2) {
  font-size: 1.3em;
}

.projection-text :deep(.rich-text h3),
.projection-text :deep(.rich-text h4),
.projection-text :deep(.rich-text .cx-heading-3),
.projection-text :deep(.rich-text .cx-heading-4) {
  font-size: 1.15em;
}

.projection-text :deep(.cx-ins),
.projection-text :deep(.cx-del) {
  padding-inline: 0.08em;
}

/*
 * The strong marks of the marks mode (.diff-marks in main.css) whatever the
 * diff mode of the laptop that projects: the room reads them from afar.
 * Colour mode keeps its tints on top of them.
 */
.projection-text :deep(.cx-ins) {
  font-weight: 700;
  text-decoration-thickness: 0.1em;
}

.projection-text :deep(.cx-del) {
  text-decoration-thickness: 0.1em;
}

.projection-text :deep(.cx-block-inserted),
.projection-text :deep(.cx-block-deleted) {
  border-inline-start-width: 4px;
}

/* The note of a format change reads with the text, not at UI size. */
.projection-text :deep(.cx-fmt-label) {
  font-size: 0.7em;
}
</style>

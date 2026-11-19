<script setup lang="ts">
import type {
  AgendaDto,
  AmendmentDto,
  DocumentAmendmentsDto,
  DocumentDto,
  HeadcountsDto,
  LiveScrollDto,
  LiveStateDto,
  SpeakerNotesDto,
  SpeakersDto,
  SpeakingTurnDto,
} from "~~/shared/types/api";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { positionsArePublic } from "~~/shared/utils/positions";
import { errorStatus } from "~/composables/api/useApi";
import { agendaWithTitles } from "~/utils/agendaTitles";
import { isDocumentLiveBatch } from "~/composables/document/useDocument";
import {
  keepLastGoodData,
  useRetryFailed,
} from "~/composables/fetch/lastGoodData";
import { buildSessionAgendaRows } from "~/composables/session/sessionModel";
import {
  affectsAgenda,
  affectsLiveVote,
  affectsSpeakers,
  liveAmendmentCode,
  liveAmendmentNote,
  liveAmendmentRows,
  liveSpeakers,
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
 * refreshing only what each event touches, and keeps the last good data
 * when a refresh fails, like the projection; when the live state never
 * loaded, it says so rather than "nothing is being debated".
 * Only published amendments are listed, so the Mesa sees what the room sees.
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
// The agenda (only for the title of the item in debate) has its own fetch
// rather than the hub's shared useAssemblyAgenda, which refetches on almost
// every live event: this is the page every delegate keeps open on a phone,
// and giving the floor or moving a turn must not make each of them fetch
// the whole agenda again. It refreshes only when the agenda can change
// (affectsAgenda), as on the projection.

const [liveFetch, speakersFetch, agendaFetch, headcountsFetch] =
  await Promise.all([
    useAsyncData(
      () => `live-view-state-${assemblyKey.value}`,
      () =>
        inSession.value
          ? api.get<LiveStateDto>(`${apiBase.value}/live-state`)
          : Promise.resolve(null),
    ),
    useAsyncData(
      () => `live-view-speakers-${assemblyKey.value}`,
      () =>
        inSession.value
          ? api.get<SpeakersDto>(`${apiBase.value}/speakers`).catch(nullIfGone)
          : Promise.resolve(null),
    ),
    useAsyncData(
      () => `live-view-agenda-${assemblyKey.value}`,
      () =>
        inSession.value
          ? api.get<AgendaDto>(`${apiBase.value}/agenda`).catch(nullIfGone)
          : Promise.resolve(null),
    ),
    useAsyncData(
      () => `live-view-headcounts-${assemblyKey.value}`,
      () =>
        inSession.value
          ? api
              .get<HeadcountsDto>(`${apiBase.value}/headcounts`)
              .catch(nullIfGone)
          : Promise.resolve(null),
    ),
  ]);
const {
  data: liveState,
  stale: liveStale,
  failed: liveFailed,
} = keepLastGoodData(liveFetch, { isGone });
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

const [documentFetch, amendmentsFetch] = await Promise.all([
  useAsyncData(
    () => `live-view-document-${documentId.value ?? "none"}`,
    () =>
      documentUrl.value
        ? api.get<DocumentDto>(documentUrl.value).catch(nullIfGone)
        : Promise.resolve(null),
  ),
  useAsyncData(
    () => `live-view-amendments-${documentId.value ?? "none"}`,
    () =>
      documentUrl.value
        ? api
            .get<DocumentAmendmentsDto>(`${documentUrl.value}/amendments`)
            .catch(nullIfGone)
        : Promise.resolve(null),
  ),
]);
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
/** The Mesa put a document on screen that is still on its way. */
const documentLoading = computed(
  () => documentId.value !== null && !document.value && !documentFailed.value,
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

// Live updates -----------------------------------------------------------------

/** When the view last heard from the server. */
const lastUpdate = ref<Date | null>(null);

onLive((events) => {
  const refreshes: Promise<unknown>[] = [];
  const poll = events.some((event) => event.type === "poll");
  // The vote on screen may change without the live state moving (its
  // unanimity): its own event reads the live state again.
  if (
    poll ||
    events.some((event) => event.entityType === "live") ||
    affectsLiveVote(events, live.value?.vote?.id)
  ) {
    refreshes.push(liveFetch.refresh());
  }
  if (affectsSpeakers(events)) refreshes.push(speakersFetch.refresh());
  if (affectsAgenda(events)) refreshes.push(agendaFetch.refresh());
  if (affectsHeadcounts(events)) refreshes.push(headcountsFetch.refresh());
  if (documentId.value && isDocumentLiveBatch(events, documentId.value)) {
    refreshes.push(documentFetch.refresh(), amendmentsFetch.refresh());
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
// assembly; the keys stay the same, so fetch again by hand.
watch(inSession, () => {
  void liveFetch.refresh();
  void speakersFetch.refresh();
  void agendaFetch.refresh();
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
      agendaFetch.refresh(),
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
  () => Boolean(debatedId.value) && amendmentsLoaded.value && !debated.value,
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
    if (scroll) mesaScroll.value = scroll;
  } catch {
    // The next position the Mesa sends puts it right.
  }
}
/** Opens the window once it knows where the Mesa is. */
async function openDocumentWindow(): Promise<void> {
  await readMesaScroll();
  documentWindowOpen.value = true;
}
watch(documentId, () => {
  if (documentWindowOpen.value) void readMesaScroll();
});

// Who spoke on what is in debate, for whoever notes it --------------------------

const { can } = useMe();
const canNoteSpeakers = computed(
  () =>
    can(PERMISSION_KEYS.SESSION_MODERATE) ||
    can(PERMISSION_KEYS.SESSION_RECORD_SPEAKERS),
);
const spokenTurns = ref<SpeakingTurnDto[]>([]);
async function readSpokenTurns(): Promise<void> {
  if (!canNoteSpeakers.value || !inSession.value) return;
  try {
    const dto = await api.get<SpeakerNotesDto>(
      `${apiBase.value}/speakers/notes`,
    );
    spokenTurns.value = dto.turns;
  } catch {
    // The next change of the speakers reads them again.
  }
}
onMounted(() => void readSpokenTurns());
watch(inSession, () => void readSpokenTurns());
onLive((events) => {
  if (events.some((event) => event.entityType === "speakers")) {
    void readSpokenTurns();
  }
});

/** The amendment previewed from the list; null when none is. */
const previewAmendmentId = ref<string | null>(null);
watch(documentId, () => {
  previewAmendmentId.value = null;
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

watch(
  () => debated.value?.amendment.id ?? document.value?.id ?? null,
  (id, previous) => {
    if (!id || id === previous) return;
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
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-8">
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

    <!-- After the session -->
    <CommonEmptyState
      v-else-if="status === 'closed'"
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

      <!--
        The live state never loaded: say so instead of "nothing in debate".
        It is retried on its own (useRetryFailed); the button only hurries it.
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

      <!-- Nothing in debate yet -->
      <CommonEmptyState
        v-else-if="nothingInDebate"
        icon="i-lucide-hourglass"
        :title="t('liveView.idle.title')"
        :description="t('liveView.idle.description')"
        variant="outline"
        size="sm"
      />

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
        @view-document="openDocumentWindow"
      />
      <LiveViewDocumentWindow
        v-model:open="documentWindowOpen"
        :document="document"
        :loading="documentLoading"
        :scroll="mesaScroll"
        :document-path="documentPath"
      />

      <section
        v-if="canNoteSpeakers && !nothingInDebate && !amendmentHidden && live"
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
            @updated="spokenTurns = $event"
          />
        </div>
      </section>

      <LiveViewSpeakers v-if="speakers" :speakers="speakers" />

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
        />
      </section>

      <LiveViewAttendance v-if="headcountsDto" :attendance="attendance" />

      <LiveViewAmendmentList
        v-if="showAmendments && documentPath"
        :rows="amendmentRows"
        :consolidated-path="consolidatedPath"
        @preview="previewAmendmentId = $event"
      />
      <LiveViewAmendmentWindow
        v-if="showAmendments"
        v-model:amendment-id="previewAmendmentId"
        :rows="amendmentRows"
        :document="document"
        :show-position="showPosition"
        :document-path="documentPath"
      />
    </template>
  </div>
</template>

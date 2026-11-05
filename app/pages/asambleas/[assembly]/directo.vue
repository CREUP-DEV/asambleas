<script setup lang="ts">
import type {
  AgendaDto,
  AmendmentDto,
  DocumentAmendmentsDto,
  DocumentDto,
  LiveStateDto,
  SpeakersDto,
} from "~~/shared/types/api";
import { errorStatus } from "~/composables/api/useApi";
import { isDocumentLiveBatch } from "~/composables/document/useDocument";
import {
  keepLastGoodData,
  useRetryFailed,
} from "~/composables/fetch/lastGoodData";
import { buildSessionAgendaRows } from "~/composables/session/sessionModel";
import {
  affectsAgenda,
  affectsSpeakers,
  liveAmendmentCode,
  liveAmendmentRows,
  liveSpeakers,
  liveVoteSubject,
  liveVoteSubjectText,
} from "~/components/live-view/-model";

/**
 * Live view for attendees (/asambleas/<slug>/directo), phone first: what
 * the Mesa has in debate (agenda item, document, amendment with its change
 * in readable type), who has the floor and who is next while the Mesa
 * shows it, the last result, and where every amendment of the document
 * stands, with the provisional consolidated text one tap away.
 *
 * Open to everyone who can see the assembly, at any time: before the
 * session and after it, it says so and points to what can be read
 * meanwhile. It follows the hub's live stream (useCurrentAssembly().onLive),
 * refreshing only what each event touches, and keeps the last good data
 * when a refresh fails, like the projection; when the live state never
 * loaded, it says so rather than "nothing is being debated".
 * Only published amendments are listed, so the Mesa sees what the room sees.
 */

const { t, locale } = useI18n();
const api = useApi();
const {
  assembly,
  apiBase,
  sectionPath,
  onLive,
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

const [liveFetch, speakersFetch, agendaFetch] = await Promise.all([
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
  data: agenda,
  stale: agendaStale,
  failed: agendaFailed,
} = keepLastGoodData(agendaFetch, { isGone });

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
  if (poll || events.some((event) => event.entityType === "live")) {
    refreshes.push(liveFetch.refresh());
  }
  if (affectsSpeakers(events)) refreshes.push(speakersFetch.refresh());
  if (affectsAgenda(events)) refreshes.push(agendaFetch.refresh());
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
const amendmentRows = computed(() =>
  liveAmendmentRows(amendments.value, debatedId.value),
);
const debated = computed(
  () => amendmentRows.value.find((row) => row.current) ?? null,
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

const speakers = computed(() =>
  inSession.value
    ? liveSpeakers(speakersDto.value, live.value?.speakersVisible ?? false)
    : null,
);

const vote = computed(() => live.value?.vote ?? null);
const voteSubject = computed(() =>
  vote.value
    ? liveVoteSubjectText(
        liveVoteSubject(vote.value, {
          amendments: amendments.value,
          document: document.value,
        }),
        t,
      )
    : "",
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

const startDate = computed(() =>
  assembly.value
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

watch(
  () => speakers.value?.current?.id ?? null,
  (id, previous) => {
    const turn = speakers.value?.current;
    if (!id || id === previous || !turn) return;
    announcement.value = t("liveView.announce.speaker", {
      name:
        turn.speaker?.trim() ||
        turn.member?.name ||
        t("liveView.speakers.unnamed"),
    });
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

    <!-- Before the session -->
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
        :amendment-hidden="amendmentHidden"
        :document-path="documentPath"
      />

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
        <LiveViewVoteResult :vote="vote" :subject="voteSubject" />
      </section>

      <LiveViewAmendmentList
        v-if="showAmendments && documentPath"
        :rows="amendmentRows"
        :document-path="documentPath"
        :consolidated-path="consolidatedPath"
      />
    </template>
  </div>
</template>

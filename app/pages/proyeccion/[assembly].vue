<script setup lang="ts">
import type {
  AgendaDto,
  AssemblyDto,
  DocumentAmendmentsDto,
  DocumentDto,
  HeadcountsDto,
  LiveEventDto,
  LiveStateDto,
  SpeakersDto,
  VoteDto,
} from "~~/shared/types/api";
import { errorStatus, useApi } from "~/composables/api/useApi";
import {
  keepLastGoodData,
  useRetryFailed,
} from "~/composables/fetch/lastGoodData";
import { useAssemblyLive } from "~/composables/live/useAssemblyLive";
import { useAppNow } from "~/composables/time/useAppNow";
import {
  buildSessionAgendaRows,
  sessionConnectionState,
} from "~/composables/session/sessionModel";
import { agendaWithTitles } from "~/utils/agendaTitles";
import { formatTime } from "~/utils/format";
import {
  affectsAgenda,
  affectsSpeakers,
  liveAmendmentRows,
  liveAmendmentStats,
  liveSpeakers,
  liveVoteCounts,
  liveVoteSubject,
  liveVoteSubjectText,
} from "~/components/live-view/-model";
import {
  affectsHeadcounts,
  liveAttendance,
} from "~/components/live-view/-attendance";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";

/**
 * Projection screen for the room: chrome-free, large type, high contrast.
 * It shows what the Mesa puts in debate (agenda item, document, amendment
 * with its diff and one block of context), the result of the last vote and
 * the Mesa's message; when nothing is in debate, the agenda. While the Mesa
 * makes the speaking turns visible, a band at the bottom shows who has the
 * floor and who is next. The header also shows the Mesa's latest
 * headcount (members present, quorum and the majorities it gives), for
 * transparency. It follows the live state and is open to every signed-in
 * user.
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
const api = useApi();

const param = computed(() => String(route.params.assembly ?? ""));
const assemblyUrl = computed(
  () => `/api/assemblies/${encodeURIComponent(param.value)}`,
);

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

const assemblyFetch = await useFetch<AssemblyDto>(() => assemblyUrl.value, {
  key: computed(() => `assembly-${param.value}`),
});

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
  () => api.get<LiveStateDto>(`${assemblyUrl.value}/live-state`),
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
  () => api.get<AgendaDto>(`${assemblyUrl.value}/agenda`),
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
  () => api.get<SpeakersDto>(`${assemblyUrl.value}/speakers`).catch(nullIfGone),
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
    api.get<HeadcountsDto>(`${assemblyUrl.value}/headcounts`).catch(nullIfGone),
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
      ? api.get<DocumentDto>(documentUrl.value).catch(nullIfGone)
      : Promise.resolve(null),
);
// Reset when the Mesa moves to another document: the previous one must not
// stand in for it if its fetch fails.
const {
  data: document,
  stale: documentStale,
  failed: documentFailed,
} = keepLastGoodData(documentFetch, { isGone, resetOn: documentId });
const refreshDocument = documentFetch.refresh;

const amendmentsFetch = await useAsyncData(
  () => `projection-amendments-${documentId.value ?? "none"}`,
  () =>
    documentUrl.value
      ? api
          .get<DocumentAmendmentsDto>(`${documentUrl.value}/amendments`)
          .catch(nullIfGone)
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

  if (poll || touches(["live"])) refreshes.push(refreshLive());
  if (affectsSpeakers(events)) refreshes.push(refreshSpeakers());
  if (affectsHeadcounts(events)) refreshes.push(refreshHeadcounts());
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

const { connected, polling } = useAssemblyLive(() => assemblyId, onLive);

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
const connectionLabel = computed(() => {
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
    onRecovered: () => {
      lastUpdate.value = new Date();
    },
  },
);

// Derived ------------------------------------------------------------------------

// Only the agenda everyone has: the projector is usually opened on a Mesa or
// Secretaría account, which also receives the items that are not public yet
// (no number: unlisted, or under an unlisted one). The room never reads
// those, except the one the Mesa itself puts on screen.
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
const amendments = computed(() => amendmentsDto.value?.amendments ?? []);
const debated = computed(() =>
  live.value?.amendmentId
    ? (amendments.value.find((item) => item.id === live.value!.amendmentId) ??
      null)
    : null,
);
const base = computed(() => document.value?.baseVersion?.blocks ?? []);
const vote = computed<VoteDto | null>(() => live.value?.vote ?? null);
const message = computed(() => live.value?.message?.trim() || null);

const mode = computed<"amendment" | "document" | "idle">(() => {
  if (debated.value) return "amendment";
  if (document.value) return "document";
  return "idle";
});

const voteSubject = computed(() =>
  vote.value
    ? liveVoteSubjectText(
        liveVoteSubject(vote.value, {
          amendments: amendments.value,
          document: document.value ?? null,
        }),
        t,
      )
    : "",
);

const voteCounts = computed(() =>
  vote.value ? liveVoteCounts(vote.value) : [],
);

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
  const parts = [
    t("projection.attendance.present", {
      present: value.latest.present,
      eligible: value.latest.eligible,
    }),
    value.latest.quorum
      ? t("session.headcount.quorum")
      : t("session.headcount.noQuorum"),
  ];
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

// Only what the room can read: the projector is usually opened on a Mesa or
// Secretaría account, whose list also holds amendments pending validation,
// validated but unpublished, or waiting for the presenter. Counting those
// would show the room that private amendments exist, and how many.
const amendmentStats = computed(() =>
  liveAmendmentStats(liveAmendmentRows(amendments.value, null)),
);

// Clock and fullscreen -----------------------------------------------------------

// The app's shared clock: it ticks right after every minute boundary.
const now = useAppNow();
const clock = computed(() => formatTime(now.value, { locale: locale.value }));

const {
  isFullscreen,
  isSupported: fullscreenSupported,
  toggle: toggleFullscreen,
} = useFullscreen();

useHead(() => ({
  title: t("projection.pageTitle", { label: assembly.value?.label ?? "" }),
}));
</script>

<template>
  <div
    class="projection bg-default text-highlighted flex min-h-dvh flex-col font-sans"
  >
    <header
      class="border-default flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-[clamp(1rem,3vw,3rem)] py-[clamp(0.75rem,1.5vw,1.5rem)]"
    >
      <img
        src="/marca/horizontal-corto-granate.svg"
        :alt="t('projection.logo')"
        class="h-[clamp(2rem,3.5vw,3.5rem)] w-auto dark:hidden"
      />
      <img
        src="/marca/horizontal-corto-blanco.svg"
        :alt="t('projection.logo')"
        class="hidden h-[clamp(2rem,3.5vw,3.5rem)] w-auto dark:block"
      />
      <div class="min-w-0 flex-1">
        <p class="text-[clamp(1.25rem,2vw,2.25rem)] leading-tight font-bold">
          {{ assembly?.label }}
        </p>
        <p
          v-if="currentRow"
          class="text-muted truncate text-[clamp(1rem,1.4vw,1.5rem)]"
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
        {{ attendanceLine }}
      </p>
      <div class="flex items-center gap-3">
        <!-- Fullscreen support is only known in the browser. -->
        <ClientOnly>
          <span
            class="text-[clamp(1.25rem,2vw,2.25rem)] font-semibold tabular-nums"
            :aria-label="t('projection.clock', { time: clock })"
          >
            {{ clock }}
          </span>
          <UButton
            v-if="fullscreenSupported"
            color="neutral"
            variant="ghost"
            size="lg"
            :icon="isFullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'"
            :aria-label="
              isFullscreen
                ? t('projection.exitFullscreen')
                : t('projection.fullscreen')
            "
            @click="toggleFullscreen()"
          />
        </ClientOnly>
      </div>
    </header>

    <main
      class="flex flex-1 flex-col gap-[clamp(1rem,2vw,2rem)] px-[clamp(1rem,3vw,3rem)] py-[clamp(1rem,2vw,2rem)] text-[clamp(1.125rem,1.5vw,2rem)]"
    >
      <section
        v-if="vote"
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
          v-if="vote.method === 'assent'"
          class="mt-[clamp(0.5rem,1vw,1rem)] text-[clamp(1.25rem,2vw,2.25rem)] leading-tight font-semibold"
        >
          {{ t("session.enums.approvalMethod.assent") }}
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

      <section
        v-if="mode === 'amendment' && debated"
        class="flex flex-1 flex-col gap-[clamp(0.75rem,1.5vw,1.5rem)]"
        aria-live="polite"
      >
        <div class="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div class="min-w-0">
            <p class="text-muted text-[clamp(1rem,1.4vw,1.5rem)]">
              {{ document?.reference ?? document?.title }}
            </p>
            <h1
              class="text-[clamp(2.25rem,4.5vw,5rem)] leading-none font-extrabold tracking-tight"
            >
              {{ t("projection.amendment", { code: debated.code ?? "" }) }}
            </h1>
          </div>
          <div class="flex flex-wrap items-center gap-2 pb-1">
            <UBadge
              color="neutral"
              variant="outline"
              size="xl"
              :label="t(`session.enums.amendmentKind.${debated.kind}`)"
            />
            <CommonMemberBadge
              v-for="author in debated.authors"
              :key="author.id"
              :member="author"
              size="xl"
              variant="solid"
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
        <div
          class="projection-text border-default min-h-0 flex-1 rounded-2xl border p-[clamp(1rem,2.5vw,2.5rem)]"
        >
          <ContentAmendmentDiff
            :id="debated.id"
            :base="base"
            :ops="debated.ops"
            :context="1"
          />
        </div>
      </section>

      <section
        v-else-if="mode === 'document' && document"
        class="grid flex-1 gap-[clamp(1rem,3vw,3rem)] lg:grid-cols-[3fr_2fr]"
        aria-live="polite"
      >
        <div class="space-y-[clamp(0.75rem,1.5vw,1.5rem)]">
          <p class="text-muted text-[clamp(1rem,1.4vw,1.5rem)]">
            {{ t("projection.inDebate") }}
          </p>
          <h1
            class="text-[clamp(2rem,4vw,4.5rem)] leading-tight font-extrabold tracking-tight"
          >
            {{ document.title }}
          </h1>
          <div class="flex flex-wrap items-center gap-2">
            <UBadge
              v-if="document.reference"
              color="neutral"
              variant="outline"
              size="xl"
              :label="document.reference"
            />
            <CommonMemberBadge
              v-if="document.proponent"
              :member="document.proponent"
              size="xl"
              variant="solid"
              show-name
            />
          </div>
          <p v-if="live?.amendmentId && !debated" class="text-muted">
            {{ t("projection.amendmentHidden") }}
          </p>
          <p
            v-if="document.amendable && amendmentStats.total > 0"
            class="text-default text-[clamp(1.25rem,2vw,2.25rem)] tabular-nums"
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
            class="text-[clamp(1.25rem,2vw,2.25rem)] font-bold"
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
        <nav :aria-label="t('projection.agenda')" class="hidden lg:block">
          <SessionProjectionAgenda
            :rows="rows"
            :current-id="live?.agendaItemId ?? null"
            size="compact"
          />
        </nav>
      </section>

      <section v-else class="flex flex-1 flex-col gap-[clamp(1rem,2vw,2rem)]">
        <h1 class="text-[clamp(2rem,4vw,4.5rem)] leading-tight font-extrabold">
          {{ t("projection.agenda") }}
        </h1>
        <!-- An agenda that never loaded is not an empty agenda -->
        <p v-if="rows.length === 0" class="text-muted">
          {{ agenda ? t("projection.agendaEmpty") : t("agenda.loadError") }}
        </p>
        <SessionProjectionAgenda
          v-else
          :rows="rows"
          :current-id="live?.agendaItemId ?? null"
        />
      </section>
      <!--
        Nobody scrolls a projector: the band sticks to the bottom of the
        screen when a long diff or agenda overflows it. The opaque wrapper
        hides the text scrolling behind the translucent band.
      -->
      <div
        v-if="speakers"
        class="bg-default sticky bottom-0 z-10 mt-auto pt-2 pb-[clamp(0.25rem,0.5vw,0.5rem)]"
      >
        <LiveViewSpeakers
          :speakers="speakers"
          size="projection"
          heading-id="projection-speakers-title"
        />
      </div>
    </main>

    <footer
      class="border-default text-muted flex flex-wrap items-center justify-between gap-2 border-t px-[clamp(1rem,3vw,3rem)] py-2 text-sm"
    >
      <span class="inline-flex items-center gap-2" role="status">
        <span
          class="size-2.5 rounded-full"
          :class="CONNECTION_DOT[connection]"
          aria-hidden="true"
        />
        {{ connectionLabel }}
      </span>
      <ClientOnly>
        <span class="inline-flex flex-wrap items-center gap-x-3">
          <span v-if="stale" class="text-warning font-medium">
            {{ t("projection.stale") }}
          </span>
          <span v-else-if="failed" class="text-warning font-medium">
            {{ t("projection.loadFailed") }}
          </span>
          <span v-if="lastUpdate">
            {{
              t("projection.updated", {
                time: formatTime(lastUpdate, { locale }),
              })
            }}
          </span>
        </span>
      </ClientOnly>
    </footer>
  </div>
</template>

<style scoped>
.projection-text :deep(.rich-text) {
  font-size: clamp(1.375rem, 2.3vw, 3rem);
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
</style>

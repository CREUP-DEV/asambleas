<script setup lang="ts">
import type { DocumentSummaryDto, MeWorkDto } from "~~/shared/types/api";
import { agendaItemAnchor } from "~/components/agenda/ItemNode.vue";
import {
  homeWorkForAssembly,
  homeWorkReviewPending,
  homeWorkTasks,
  homeWorkUpdates,
} from "~/components/home/-work";
import { useAddDocument } from "~/composables/document/useAddDocument";
import { formatDateTime } from "~/utils/format";

/**
 * Assembly overview: what the signed-in user has to do here and, for the
 * Secretaría, what waits for its review; then a line of key figures, an
 * agenda summary with documents and amendment counts, and the calendar
 * timeline with the countdown to the next milestone and its warnings.
 * Anyone acting for a member always sees their tasks card, even with
 * nothing in it, so they know where requests will show up.
 *
 * While documents can be presented, a strip at the top says until when and
 * offers "Añadir documento" ("Presentar documento" for members), which opens
 * the new-document modal with the item to choose (useAddDocument); the
 * editor comes back here, or with the modal open on the next item.
 */

const { t, locale } = useI18n();
const localePath = useLocalePath();
const { member } = useMe();
const current = useCurrentAssembly();
const { assembly, sectionPath } = current;

useHead({
  title: () =>
    [t("assembly.overview.title"), assembly.value?.label]
      .filter(Boolean)
      .join(" · "),
});

const {
  data: agenda,
  pending: agendaPending,
  error: agendaError,
  refresh: refreshAgenda,
} = await useAssemblyAgenda();

// Adding documents ----------------------------------------------------------

const addDocument = useAddDocument(agenda);

/** The calendar's deadline for presenting documents, if set. */
const documentsClose = computed(
  () =>
    assembly.value?.milestones.find(
      (milestone) => milestone.key === "documents_close",
    )?.at ?? null,
);

async function onDocumentCreated(): Promise<void> {
  await Promise.all([refreshAgenda(), refreshWork()]);
}

// Your work here ----------------------------------------------------------

// Shared with the home page; not awaited, so the overview never waits for
// it, and a failure only leaves these summaries out.
const { data: work, refresh: refreshWork } = useFetch<MeWorkDto>(
  "/api/me/work",
  { key: "me-work", lazy: true },
);

current.onLive((events) => {
  if (
    events.some(
      (event) =>
        event.type === "poll" ||
        event.entityType === "document" ||
        event.entityType === "amendment",
    )
  ) {
    void refreshWork();
  }
});

const now = useAppNow();

const assemblyWork = computed(() =>
  work.value && assembly.value
    ? homeWorkForAssembly(work.value, assembly.value.id)
    : null,
);
const myTasks = computed(() =>
  assemblyWork.value ? homeWorkTasks(assemblyWork.value, now.value) : [],
);
const myUpdates = computed(() =>
  assemblyWork.value ? homeWorkUpdates(assemblyWork.value) : [],
);
const pendingReview = computed(
  () =>
    (assemblyWork.value
      ? homeWorkReviewPending(assemblyWork.value.review)
      : [])[0] ?? null,
);

/** Tasks shown here; the rest are on the home page. */
const TASK_LIMIT = 3;
const shownTasks = computed(() => myTasks.value.slice(0, TASK_LIMIT));
/** Something presented here, whether or not there is anything to do. */
const hasWork = computed(
  () => myTasks.value.length > 0 || myUpdates.value.length > 0,
);
// Once the work list is in: always for a member, otherwise only with work.
const showMine = computed(
  () => Boolean(assemblyWork.value) && (Boolean(member.value) || hasWork.value),
);

const tree = computed(() => buildAgendaTree(agenda.value?.items ?? []));
const rows = computed(() => flattenAgendaTree(tree.value));

const documentsByItem = computed(() => {
  const map = new Map<string, DocumentSummaryDto[]>();
  for (const document of agenda.value?.documents ?? []) {
    const list = map.get(document.agendaItemId);
    if (list) list.push(document);
    else map.set(document.agendaItemId, [document]);
  }
  return map;
});

/** Documents and amendments of every item, including its sub-items. */
const totals = computed(() => {
  const items = agenda.value?.items ?? [];
  const map = new Map<string, { documents: number; amendments: number }>();
  for (const item of items) {
    let documents = 0;
    let amendments = 0;
    for (const id of agendaSubtreeIds(items, item.id)) {
      for (const document of documentsByItem.value.get(id) ?? []) {
        documents += 1;
        amendments += document.amendmentCount;
      }
    }
    map.set(item.id, { documents, amendments });
  }
  return map;
});

const totalsFor = (itemId: string) =>
  totals.value.get(itemId) ?? { documents: 0, amendments: 0 };

const stats = computed(() => {
  const documents = agenda.value?.documents ?? [];
  return {
    items: agenda.value?.items.length ?? 0,
    documents: documents.length,
    published: documents.filter((document) => document.status === "published")
      .length,
    amendments: documents.reduce(
      (total, document) => total + document.amendmentCount,
      0,
    ),
    openWindows: documents.filter(
      (document) =>
        document.amendable &&
        document.status === "published" &&
        document.window.open,
    ).length,
  };
});

/** One quiet line of figures; open amendment windows only when there are some. */
const figures = computed(() =>
  [
    {
      key: "items",
      value: stats.value.items,
      label: t("assembly.overview.stats.items", stats.value.items),
      hint: null as string | null,
    },
    {
      key: "documents",
      value: stats.value.documents,
      label: t("assembly.overview.stats.documents", stats.value.documents),
      hint:
        stats.value.documents > 0
          ? t(
              "assembly.overview.stats.published",
              { count: stats.value.published },
              stats.value.published,
            )
          : null,
    },
    {
      key: "amendments",
      value: stats.value.amendments,
      label: t("assembly.overview.stats.amendments", stats.value.amendments),
      hint: null,
    },
    {
      key: "windows",
      value: stats.value.openWindows,
      label: t("assembly.overview.stats.openWindows", stats.value.openWindows),
      hint: null,
    },
  ].filter((figure) => figure.key !== "windows" || figure.value > 0),
);

const warnedKeys = computed(() =>
  (assembly.value?.calendarWarnings ?? []).flatMap((warning) => warning.keys),
);
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <h2 class="sr-only">{{ t("assembly.overview.title") }}</h2>

    <CalendarWarningList
      v-if="assembly.can.manage && assembly.calendarWarnings.length > 0"
      :warnings="assembly.calendarWarnings"
      :edit-to="sectionPath('calendario')"
    />

    <!-- Documents can be presented: until when, and the way to add one -->
    <section
      v-if="addDocument.canAdd.value && addDocument.items.value.length > 0"
      class="border-default flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
      aria-labelledby="overview-add-document-title"
      data-testid="overview-add-document"
    >
      <div class="min-w-0 space-y-1">
        <h3
          id="overview-add-document-title"
          class="text-highlighted flex items-center gap-2 font-semibold"
        >
          <UIcon
            name="i-lucide-file-plus"
            class="text-primary size-5 shrink-0"
            aria-hidden="true"
          />
          {{ t("assembly.overview.addDocument.title") }}
        </h3>
        <p v-if="documentsClose" class="text-muted text-sm">
          {{
            t("assembly.overview.addDocument.until", {
              date: formatDateTime(documentsClose, { style: "long", locale }),
            })
          }}
          <CommonCountdown
            :to="documentsClose"
            :urgent-hours="48"
            icon="i-lucide-hourglass"
          />
        </p>
      </div>
      <UButton
        icon="i-lucide-file-plus"
        :label="
          addDocument.manager.value
            ? t('agenda.newDocument.title')
            : t('agenda.newDocument.submitTitle')
        "
        @click="addDocument.openFor(null)"
      />
    </section>

    <AgendaNewDocumentModal
      v-model:open="addDocument.open.value"
      :api-base="current.apiBase.value"
      :base-path="sectionPath()"
      :items="addDocument.items.value"
      :item-id="addDocument.itemId.value"
      :mode="addDocument.mode.value"
      origin="home"
      @created="onDocumentCreated"
    />

    <!-- Your part in this assembly -->
    <div
      v-if="pendingReview || showMine"
      class="grid gap-4"
      :class="pendingReview && showMine ? 'lg:grid-cols-2' : ''"
    >
      <HomeReviewCard
        v-if="pendingReview"
        :review="pendingReview"
        :title="t('assembly.overview.review.title')"
        :heading-level="3"
      />

      <UCard
        v-if="showMine"
        as="section"
        aria-labelledby="overview-tasks-title"
        :ui="{
          body: 'p-4 sm:p-5',
          header: 'p-4 sm:px-5',
          footer: 'p-4 sm:px-5',
        }"
      >
        <template #header>
          <h3
            id="overview-tasks-title"
            class="text-highlighted flex items-center gap-2 font-semibold"
          >
            <UIcon
              name="i-lucide-list-todo"
              class="text-primary size-5 shrink-0"
              aria-hidden="true"
            />
            {{ t("assembly.overview.tasks.title") }}
          </h3>
        </template>

        <HomeTaskList
          v-if="shownTasks.length > 0"
          :tasks="shownTasks"
          :show-assembly="false"
          compact
          :primary="!pendingReview"
        />
        <p
          v-else-if="hasWork"
          class="text-default flex items-start gap-2 text-sm"
        >
          <UIcon
            name="i-lucide-circle-check-big"
            class="text-success mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("assembly.overview.tasks.upToDate") }}
        </p>
        <p v-else class="text-muted flex items-start gap-2 text-sm">
          <UIcon
            name="i-lucide-inbox"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("assembly.overview.tasks.empty") }}
        </p>

        <template v-if="hasWork" #footer>
          <UButton
            variant="link"
            color="neutral"
            trailing-icon="i-lucide-arrow-right"
            class="px-0"
            :to="localePath('/')"
            :label="
              myTasks.length > shownTasks.length
                ? t(
                    'assembly.overview.tasks.more',
                    { count: myTasks.length - shownTasks.length },
                    myTasks.length - shownTasks.length,
                  )
                : t('assembly.overview.tasks.all')
            "
          />
        </template>
      </UCard>
    </div>

    <!-- Key figures: one quiet line -->
    <section :aria-label="t('assembly.overview.statsLabel')">
      <div
        v-if="agendaPending && !agenda"
        class="flex flex-wrap gap-x-6 gap-y-2"
        role="status"
      >
        <span class="sr-only">{{ t("assembly.overview.loading") }}</span>
        <USkeleton
          v-for="index in 3"
          :key="index"
          aria-hidden="true"
          class="h-6 w-36"
        />
      </div>
      <ul
        v-else
        class="text-muted flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm"
      >
        <li
          v-for="figure in figures"
          :key="figure.key"
          class="flex items-baseline gap-1.5"
        >
          <span class="text-highlighted text-lg font-semibold tabular-nums">
            {{ figure.value }}
          </span>
          <span>{{ figure.label }}</span>
          <span v-if="figure.hint" class="text-dimmed"
            >({{ figure.hint }})</span
          >
        </li>
      </ul>
    </section>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <!-- Agenda summary -->
      <UCard as="section" aria-labelledby="overview-agenda-title">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="overview-agenda-title"
              class="text-highlighted font-semibold"
            >
              {{ t("assembly.overview.agendaTitle") }}
            </h3>
            <UBadge
              :color="assembly.agendaFinalizedAt ? 'success' : 'neutral'"
              variant="subtle"
              size="sm"
              :label="
                assembly.agendaFinalizedAt
                  ? t('agenda.final')
                  : t('agenda.provisional')
              "
            />
          </div>
        </template>

        <div v-if="agendaPending && !agenda" class="space-y-2" role="status">
          <span class="sr-only">{{ t("agenda.loading") }}</span>
          <USkeleton
            v-for="index in 5"
            :key="index"
            aria-hidden="true"
            class="h-8 w-full"
          />
        </div>
        <UAlert
          v-else-if="agendaError && !agenda"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('agenda.loadError')"
          :actions="[
            {
              label: t('agenda.retry'),
              color: 'neutral',
              variant: 'outline',
              onClick: () => {
                void refreshAgenda();
              },
            },
          ]"
        />
        <CommonEmptyState
          v-else-if="rows.length === 0"
          icon="i-lucide-list-tree"
          :title="t('agenda.emptyTitle')"
          :description="t('agenda.emptyDescription')"
          size="sm"
        >
          <template v-if="assembly.can.manage" #action>
            <UButton
              size="sm"
              icon="i-lucide-plus"
              :label="t('agenda.addItem')"
              :to="sectionPath('orden-del-dia')"
            />
          </template>
        </CommonEmptyState>
        <ol v-else class="divide-default -my-2 divide-y">
          <li
            v-for="row in rows"
            :key="row.item.id"
            class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2"
            :style="{ paddingInlineStart: `${row.depth * 1.25}rem` }"
          >
            <NuxtLink
              :to="`${sectionPath('orden-del-dia')}#${agendaItemAnchor(row.item.id)}`"
              class="text-default hover:text-primary focus-visible:outline-primary min-w-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              :class="row.depth === 0 ? 'font-medium' : 'text-sm'"
            >
              <span class="text-primary me-1.5 tabular-nums"
                >{{ row.number }}.</span
              >
              <span class="break-words">{{ row.item.title }}</span>
            </NuxtLink>
            <span
              v-if="totalsFor(row.item.id).documents > 0"
              class="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums"
            >
              <span class="inline-flex items-center gap-1">
                <UIcon
                  name="i-lucide-file"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {{
                  t(
                    "assembly.overview.documentCount",
                    { count: totalsFor(row.item.id).documents },
                    totalsFor(row.item.id).documents,
                  )
                }}
              </span>
              <span class="inline-flex items-center gap-1">
                <UIcon
                  name="i-lucide-message-square-diff"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {{
                  t(
                    "assembly.overview.amendmentCount",
                    { count: totalsFor(row.item.id).amendments },
                    totalsFor(row.item.id).amendments,
                  )
                }}
              </span>
            </span>
          </li>
        </ol>

        <template #footer>
          <UButton
            variant="link"
            trailing-icon="i-lucide-arrow-right"
            :label="t('assembly.overview.openAgenda')"
            :to="sectionPath('orden-del-dia')"
            class="px-0"
          />
        </template>
      </UCard>

      <!-- Calendar -->
      <UCard as="section" aria-labelledby="overview-calendar-title">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="overview-calendar-title"
              class="text-highlighted font-semibold"
            >
              {{ t("assembly.overview.calendarTitle") }}
            </h3>
            <span
              v-if="assembly.nextMilestone"
              class="text-muted flex flex-wrap items-center gap-1 text-sm"
            >
              {{ t(`calendar.milestones.${assembly.nextMilestone.key}`) }}
              <CommonCountdown
                :to="assembly.nextMilestone.at"
                icon="i-lucide-hourglass"
                :urgent-hours="72"
              />
            </span>
          </div>
        </template>
        <CalendarMilestoneTimeline
          :milestones="assembly.milestones"
          :start-date="assembly.startDate"
          :warned-keys="assembly.can.manage ? warnedKeys : []"
        />
        <template v-if="assembly.can.manage" #footer>
          <UButton
            variant="link"
            trailing-icon="i-lucide-arrow-right"
            :label="t('assembly.overview.editCalendar')"
            :to="sectionPath('calendario')"
            class="px-0"
          />
        </template>
      </UCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { isReadOnlyRole } from "~~/shared/constants/roles";
import type { MeWorkDto } from "~~/shared/types/api";
import {
  homeWorkForAssembly,
  homeWorkReviewPending,
  homeWorkTasks,
  homeWorkUpdates,
} from "~/components/home/-work";
import { welcomeAudience } from "~/components/shell/-welcome";
import { agendaItemPath } from "~/composables/document/agendaReturn";
import { useAddDocument } from "~/composables/document/useAddDocument";
import { formatDateTime } from "~/utils/format";

/**
 * Assembly overview. At most three blocks stand in first plane, for every
 * role:
 *
 * 1. "Te toca": what the signed-in user has to do here. While documents can
 *    be presented, a strip says until when and offers "Añadir documento"
 *    ("Presentar documento" for members), which opens the new-document modal
 *    with the item to choose (useAddDocument); the editor comes back here,
 *    or with the modal open on the next item. Then, for the Secretaría, what
 *    waits for its review, and the user's tasks. Anyone acting for a member
 *    always sees their tasks card, even with nothing in it, so they know
 *    where requests will show up; a read-only account (Otro, Invitado) reads one sentence
 *    saying the account can only read.
 * 2. "Lo siguiente": the next milestone of the calendar, one line that
 *    opens the calendar.
 * 3. The agenda summary with documents and amendment counts (each item
 *    opens its own page).
 *
 * The key figures and the full calendar timeline (with its warnings for
 * managers) stay one click away in folded sections under them (HomeFold).
 * The managers' alerts (calendar warnings, an overdue final agenda) are
 * notices, not blocks, and stay on top.
 */

const { t, locale } = useI18n();
const localePath = useLocalePath();
const { me, member } = useMe();
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

/**
 * Whether the account only reads: a guest with no permission of its own
 * (the welcome's rule, welcomeAudience).
 */
const isGuest = computed(() => {
  const account = me.value;
  return (
    !!account &&
    isReadOnlyRole(account.role) &&
    welcomeAudience(account) === "guest"
  );
});

/** The strip that offers to add a document, while it can be done. */
const canAddDocument = computed(
  () => addDocument.canAdd.value && addDocument.items.value.length > 0,
);

/**
 * A guest account with nothing here: it can only read, and the page says so
 * in one sentence once the work list is in.
 */
const readOnly = computed(
  () =>
    Boolean(assemblyWork.value) &&
    isGuest.value &&
    !canAddDocument.value &&
    !pendingReview.value &&
    !showMine.value,
);

/** Whether "Te toca" has anything to show. */
const showTodo = computed(
  () =>
    canAddDocument.value ||
    Boolean(pendingReview.value) ||
    showMine.value ||
    readOnly.value,
);

const tree = computed(() => buildAgendaTree(agenda.value?.items ?? []));
const rows = computed(() => flattenAgendaTree(tree.value));

/** Documents and amendments of every item, including its sub-items. */
const totals = computed(() =>
  agendaSubtreeTotals(agenda.value?.items ?? [], agenda.value?.documents ?? []),
);

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

    <!-- The planned date of the final agenda passed and it is still
         provisional (never for an agenda with no items yet) -->
    <AgendaFinalAction v-if="tree.length > 0" as="reminder" />

    <!-- 1. What the user has to do here -->
    <section
      v-if="showTodo"
      class="space-y-3"
      aria-labelledby="overview-todo-title"
      data-testid="overview-todo"
    >
      <h3 id="overview-todo-title" class="text-highlighted font-semibold">
        {{ t("assembly.overview.todo.title") }}
      </h3>

      <!-- Documents can be presented: until when, and the way to add one -->
      <div
        v-if="canAddDocument"
        class="border-default flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
        role="group"
        aria-labelledby="overview-add-document-title"
        data-testid="overview-add-document"
      >
        <div class="min-w-0 space-y-1">
          <h4
            id="overview-add-document-title"
            class="text-highlighted flex items-center gap-2 font-semibold"
          >
            <UIcon
              name="i-lucide-file-plus"
              class="text-primary size-5 shrink-0"
              aria-hidden="true"
            />
            {{ t("assembly.overview.addDocument.title") }}
          </h4>
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
      </div>

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
          :heading-level="4"
          :primary="!canAddDocument"
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
            <h4
              id="overview-tasks-title"
              class="text-highlighted flex items-center gap-2 font-semibold"
            >
              <UIcon
                name="i-lucide-list-todo"
                class="text-primary size-5 shrink-0"
                aria-hidden="true"
              />
              {{ t("assembly.overview.tasks.title") }}
            </h4>
          </template>

          <HomeTaskList
            v-if="shownTasks.length > 0"
            :tasks="shownTasks"
            :show-assembly="false"
            compact
            :primary="!pendingReview && !canAddDocument"
          />
          <div v-else class="space-y-1 text-sm">
            <p class="text-default flex items-start gap-2 font-medium">
              <UIcon
                name="i-lucide-circle-check-big"
                class="text-success mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {{ t("assembly.overview.todo.empty") }}
            </p>
            <p class="text-muted ps-6">
              {{
                hasWork
                  ? t("assembly.overview.tasks.upToDate")
                  : t("assembly.overview.tasks.empty")
              }}
            </p>
          </div>

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

      <p
        v-if="readOnly"
        class="border-default text-default flex items-start gap-3 rounded-lg border p-4 text-sm"
        data-testid="overview-read-only"
      >
        <UIcon
          name="i-lucide-eye"
          class="text-muted mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ t("assembly.overview.todo.readOnly") }}</span>
      </p>
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

    <!-- 2. What comes next in the calendar: one line -->
    <section
      class="border-default flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
      aria-labelledby="overview-next-title"
      data-testid="overview-next"
    >
      <div class="flex min-w-0 items-start gap-3">
        <UIcon
          name="i-lucide-calendar-clock"
          class="text-primary size-5 shrink-0"
          aria-hidden="true"
        />
        <div class="min-w-0 space-y-0.5">
          <h3 id="overview-next-title" class="text-muted text-sm font-medium">
            {{ t("assembly.overview.next.title") }}
          </h3>
          <template v-if="assembly.nextMilestone">
            <p class="text-highlighted font-medium">
              {{ t(`calendar.milestones.${assembly.nextMilestone.key}`) }}
            </p>
            <p
              class="text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
            >
              <span>
                {{
                  formatDateTime(assembly.nextMilestone.at, {
                    style: "long",
                    locale,
                  })
                }}
              </span>
              <CommonCountdown
                :to="assembly.nextMilestone.at"
                icon="i-lucide-hourglass"
                :urgent-hours="72"
              />
            </p>
          </template>
          <p v-else class="text-default text-sm">
            {{ t("assembly.overview.next.none") }}
          </p>
        </div>
      </div>
      <UButton
        color="neutral"
        variant="outline"
        trailing-icon="i-lucide-arrow-right"
        :label="t('assembly.overview.next.open')"
        :to="sectionPath('calendario')"
      />
    </section>

    <!-- 3. Agenda summary -->
    <UCard as="section" aria-labelledby="overview-agenda-title">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 id="overview-agenda-title" class="text-highlighted font-semibold">
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
            :to="agendaItemPath(sectionPath(), row.item.id)"
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

    <!-- The rest, folded: one click away -->
    <div class="space-y-3" data-testid="overview-more">
      <!-- Key figures -->
      <HomeFold
        id="overview-figures"
        :title="t('assembly.overview.statsLabel')"
        icon="i-lucide-chart-no-axes-column"
        :heading-level="3"
      >
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
      </HomeFold>

      <!-- The whole calendar -->
      <HomeFold
        id="overview-calendar"
        :title="t('assembly.overview.fullCalendar')"
        icon="i-lucide-calendar-days"
        :heading-level="3"
      >
        <CalendarMilestoneTimeline
          :milestones="assembly.milestones"
          :start-date="assembly.startDate"
          :warned-keys="assembly.can.manage ? warnedKeys : []"
        />
        <UButton
          v-if="assembly.can.manage"
          variant="link"
          trailing-icon="i-lucide-arrow-right"
          :label="t('assembly.overview.editCalendar')"
          :to="sectionPath('calendario')"
          class="mt-3 px-0"
        />
      </HomeFold>
    </div>
  </div>
</template>

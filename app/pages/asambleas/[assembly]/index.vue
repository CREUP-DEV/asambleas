<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { agendaItemAnchor } from "~/components/agenda/ItemNode.vue";

/**
 * Assembly overview: key figures, the calendar timeline with the countdown
 * to the next milestone and the calendar warnings, an agenda summary with
 * documents and amendment counts, and quick links to every section.
 */

const { t } = useI18n();
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

const statCards = computed(() => [
  {
    key: "items",
    icon: "i-lucide-list-tree",
    value: stats.value.items,
    label: t("assembly.overview.stats.items", stats.value.items),
  },
  {
    key: "documents",
    icon: "i-lucide-files",
    value: stats.value.documents,
    label: t("assembly.overview.stats.documents", stats.value.documents),
    hint: t(
      "assembly.overview.stats.published",
      { count: stats.value.published },
      stats.value.published,
    ),
  },
  {
    key: "amendments",
    icon: "i-lucide-message-square-diff",
    value: stats.value.amendments,
    label: t("assembly.overview.stats.amendments", stats.value.amendments),
  },
  {
    key: "windows",
    icon: "i-lucide-pencil-line",
    value: stats.value.openWindows,
    label: t("assembly.overview.stats.openWindows", stats.value.openWindows),
  },
]);

const warnedKeys = computed(() =>
  (assembly.value?.calendarWarnings ?? []).flatMap((warning) => warning.keys),
);

const quickLinks = computed(() => {
  const value = assembly.value;
  if (!value) return [];
  return [
    {
      key: "agenda",
      icon: "i-lucide-list-tree",
      to: sectionPath("orden-del-dia"),
      show: true,
    },
    {
      key: "convocation",
      icon: "i-lucide-scroll-text",
      to: sectionPath("convocatoria"),
      show: true,
    },
    {
      key: "calendar",
      icon: "i-lucide-calendar-clock",
      to: sectionPath("calendario"),
      show: value.can.manage,
    },
    {
      key: "settings",
      icon: "i-lucide-settings",
      to: sectionPath("ajustes"),
      show: value.can.manage,
    },
  ].filter((link) => link.show);
});
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <h2 class="sr-only">{{ t("assembly.overview.title") }}</h2>

    <CalendarWarningList
      v-if="assembly.can.manage && assembly.calendarWarnings.length > 0"
      :warnings="assembly.calendarWarnings"
      :edit-to="sectionPath('calendario')"
    />

    <!-- Key figures -->
    <section :aria-label="t('assembly.overview.statsLabel')">
      <ul class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <li v-for="card in statCards" :key="card.key">
          <UCard :ui="{ body: 'p-3 sm:p-4' }" class="h-full">
            <div class="flex items-start gap-3">
              <span
                class="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-md"
                aria-hidden="true"
              >
                <UIcon :name="card.icon" class="size-5" />
              </span>
              <div class="min-w-0">
                <USkeleton
                  v-if="agendaPending && !agenda"
                  class="mb-1 h-7 w-10"
                />
                <p
                  v-else
                  class="text-highlighted text-2xl leading-7 font-bold tabular-nums"
                >
                  {{ card.value }}
                </p>
                <p class="text-muted text-sm">{{ card.label }}</p>
                <p v-if="card.hint" class="text-dimmed text-xs">
                  {{ card.hint }}
                </p>
              </div>
            </div>
          </UCard>
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

        <div
          v-if="agendaPending && !agenda"
          class="space-y-2"
          aria-busy="true"
          :aria-label="t('agenda.loading')"
        >
          <USkeleton v-for="index in 5" :key="index" class="h-8 w-full" />
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
            class="flex items-start justify-between gap-3 py-2"
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
              class="text-muted flex shrink-0 items-center gap-2 text-xs tabular-nums"
            >
              <span class="inline-flex items-center gap-1">
                <UIcon
                  name="i-lucide-file"
                  class="size-3.5"
                  aria-hidden="true"
                />
                <span class="sr-only">{{
                  t("assembly.overview.documentsShort")
                }}</span>
                {{ totalsFor(row.item.id).documents }}
              </span>
              <span class="inline-flex items-center gap-1">
                <UIcon
                  name="i-lucide-message-square-diff"
                  class="size-3.5"
                  aria-hidden="true"
                />
                <span class="sr-only">{{
                  t("assembly.overview.amendmentsShort")
                }}</span>
                {{ totalsFor(row.item.id).amendments }}
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

    <!-- Quick links -->
    <nav :aria-label="t('assembly.overview.quickLinks')">
      <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <li v-for="link in quickLinks" :key="link.key">
          <UPageCard
            :to="link.to"
            :icon="link.icon"
            :title="t(`assembly.overview.links.${link.key}.title`)"
            :description="t(`assembly.overview.links.${link.key}.description`)"
            variant="subtle"
            class="h-full"
          />
        </li>
      </ul>
    </nav>
  </div>
</template>

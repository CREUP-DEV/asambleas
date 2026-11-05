<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import {
  groupByAgendaItem,
  matchesTrackingFilter,
  summarizeTracking,
  type TrackingFilter,
} from "~/components/tracking/-status";

/**
 * Documentation tracking (document:manage): per agenda item, every document
 * with who presents it, its internal deadline and where it stands, with the
 * counts on top (each one a filter). The Secretaría adds the documents it
 * expects from each member here and moves their deadlines in edit mode.
 *
 * Reads the shared agenda (useAssemblyAgenda), which already follows live
 * events.
 */

const { t } = useI18n();
const { can } = useMe();
const current = useCurrentAssembly();
const { assembly, apiBase, sectionPath } = current;

useHead({
  title: () =>
    [t("tracking.title"), assembly.value?.label].filter(Boolean).join(" · "),
});

const allowed = computed(() => can(PERMISSION_KEYS.DOCUMENT_MANAGE));

const { data: agenda, pending, error, refresh } = await useAssemblyAgenda();

const now = useAppNow();

const documents = computed<DocumentSummaryDto[]>(
  () => agenda.value?.documents ?? [],
);
const summary = computed(() => summarizeTracking(documents.value, now.value));

const filter = ref<TrackingFilter>("all");

const groups = computed(() =>
  groupByAgendaItem(
    agenda.value?.items ?? [],
    documents.value.filter((document) =>
      matchesTrackingFilter(document, filter.value, now.value),
    ),
  ),
);

/** Agenda items in agenda order, for the "add" form. */
const agendaOptions = computed(() =>
  flattenAgendaTree(buildAgendaTree(agenda.value?.items ?? [])).map((node) => ({
    id: node.item.id,
    number: node.number,
    title: node.item.title,
  })),
);

const hasDrafts = computed(() =>
  documents.value.some((document) => document.status === "draft"),
);

function documentPath(document: DocumentSummaryDto): string {
  return sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
}

const filterLabel = computed(() =>
  filter.value === "all"
    ? ""
    : t(`tracking.summary.${filter.value}`, summary.value[filter.value]),
);

// Adding and editing ------------------------------------------------------------

const addOpen = ref(false);
const editing = ref(false);
const statusMessage = ref("");

watch(hasDrafts, (value) => {
  if (!value) editing.value = false;
});

function toggleEditing() {
  editing.value = !editing.value;
  statusMessage.value = editing.value
    ? t("tracking.editingOn")
    : t("tracking.editingOff");
}

const deadlineTarget = ref<DocumentSummaryDto | null>(null);
const deadlineOpen = computed({
  get: () => deadlineTarget.value !== null,
  set: (open: boolean) => {
    if (!open) deadlineTarget.value = null;
  },
});

async function onCreated() {
  filter.value = "all";
  statusMessage.value = t("tracking.expected.created");
  await refresh();
}

async function onDeadlineSaved() {
  statusMessage.value = t("tracking.deadline.savedShort");
  await refresh();
}
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <CommonEmptyState
      v-if="!allowed"
      icon="i-lucide-shield-x"
      :title="t('tracking.forbiddenTitle')"
      :description="t('tracking.forbiddenDescription')"
      variant="outline"
    >
      <template #action>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('review.backToOverview')"
          :to="sectionPath()"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <h2 class="text-highlighted text-xl font-semibold">
            {{ t("tracking.title") }}
          </h2>
          <p class="text-muted max-w-3xl text-sm">{{ t("tracking.intro") }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="hasDrafts"
            color="neutral"
            variant="outline"
            :icon="editing ? 'i-lucide-check' : 'i-lucide-calendar-cog'"
            :label="
              editing ? t('tracking.editDone') : t('tracking.editDeadlines')
            "
            @click="toggleEditing"
          />
          <UButton
            v-if="agendaOptions.length > 0"
            icon="i-lucide-file-plus"
            :label="t('tracking.add')"
            @click="addOpen = true"
          />
        </div>
      </div>

      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {{ statusMessage }}
      </p>

      <div
        v-if="pending && !agenda"
        class="space-y-3"
        aria-busy="true"
        :aria-label="t('tracking.loading')"
      >
        <USkeleton class="h-16 w-full" />
        <USkeleton v-for="n in 3" :key="n" class="h-20 w-full" />
      </div>

      <UAlert
        v-else-if="error && !agenda"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('tracking.loadError')"
        :actions="[
          {
            label: t('review.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => {
              void refresh();
            },
          },
        ]"
        role="alert"
      />

      <CommonEmptyState
        v-else-if="agendaOptions.length === 0"
        icon="i-lucide-list-tree"
        :title="t('tracking.noAgendaTitle')"
        :description="t('tracking.noAgendaDescription')"
        variant="outline"
      >
        <template #action>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-list-tree"
            :label="t('tracking.toAgenda')"
            :to="sectionPath('orden-del-dia')"
          />
        </template>
      </CommonEmptyState>

      <CommonEmptyState
        v-else-if="documents.length === 0"
        icon="i-lucide-clipboard-list"
        :title="t('tracking.emptyTitle')"
        :description="t('tracking.emptyDescription')"
        variant="outline"
      >
        <template #action>
          <UButton
            icon="i-lucide-file-plus"
            :label="t('tracking.add')"
            @click="addOpen = true"
          />
        </template>
      </CommonEmptyState>

      <template v-else>
        <TrackingSummary v-model="filter" :summary="summary" />

        <UAlert
          v-if="summary.submitted > 0"
          color="info"
          variant="subtle"
          icon="i-lucide-inbox"
          :title="
            t(
              'tracking.waitingValidation',
              { count: summary.submitted },
              summary.submitted,
            )
          "
          :actions="[
            {
              label: t('tracking.toValidation'),
              color: 'info',
              variant: 'outline',
              to: sectionPath('validacion'),
            },
          ]"
        />

        <p v-if="editing" class="text-muted flex items-center gap-1.5 text-sm">
          <UIcon
            name="i-lucide-calendar-cog"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("tracking.editingHelp") }}
        </p>

        <CommonEmptyState
          v-if="groups.length === 0"
          icon="i-lucide-filter-x"
          :title="t('tracking.noMatchesTitle', { filter: filterLabel })"
          :description="t('tracking.noMatchesDescription')"
        >
          <template #action>
            <UButton
              color="neutral"
              variant="outline"
              :label="t('tracking.showAll')"
              @click="filter = 'all'"
            />
          </template>
        </CommonEmptyState>

        <div v-else class="space-y-6">
          <p v-if="filter !== 'all'" class="text-muted text-sm">
            {{ t("tracking.filtered", { filter: filterLabel }) }}
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              class="px-1"
              :label="t('tracking.showAll')"
              @click="filter = 'all'"
            />
          </p>
          <section
            v-for="group in groups"
            :key="group.itemId"
            :aria-labelledby="`tracking-item-${group.itemId}`"
            class="space-y-2"
          >
            <h3
              :id="`tracking-item-${group.itemId}`"
              class="text-muted text-sm font-semibold"
            >
              <template v-if="group.title">
                <span v-if="group.number" class="tabular-nums">
                  {{ group.number }}.
                </span>
                {{ group.title }}
              </template>
              <template v-else>{{ t("tracking.unknownItem") }}</template>
            </h3>
            <ul class="space-y-2">
              <li v-for="document in group.documents" :key="document.id">
                <TrackingDocumentRow
                  :document="document"
                  :to="documentPath(document)"
                  :editing="editing"
                  @edit-deadline="deadlineTarget = document"
                />
              </li>
            </ul>
          </section>
        </div>
      </template>

      <TrackingExpectedDocumentModal
        v-model:open="addOpen"
        :api-base="apiBase"
        :items="agendaOptions"
        @created="onCreated"
      />

      <TrackingDeadlineModal
        v-model:open="deadlineOpen"
        :api-base="apiBase"
        :document="deadlineTarget"
        @saved="onDeadlineSaved"
        @conflict="refresh"
      />
    </template>
  </div>
</template>

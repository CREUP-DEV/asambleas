<script setup lang="ts">
import type {
  ActivityItemDto,
  AgendaItemDto,
  DocumentAmendmentsDto,
  DocumentSummaryDto,
  UserRef,
} from "~~/shared/types/api";
import {
  CONTROL_SHEET_ACTIVITY_GROUP_KEYS,
  CONTROL_SHEET_ACTIVITY_GROUPS,
  type ControlSheetActivityGroup,
} from "~~/shared/constants/activity";
import { activityDateRange } from "~/composables/activity/-filters";
import { activityItemKey } from "~/composables/activity/-present";
import { buildAgendaTree, flattenAgendaTree } from "~/utils/agendaTree";

/**
 * «Historial» of the control sheet (user's decision of 2026-11-17): what
 * changed in the sheet or about it, newest first, by anyone: its notes, the
 * main presenters' answers, and the votes and decisions
 * (CONTROL_SHEET_ACTIVITY_GROUPS; GET .../control-sheet/activity, each row
 * judged for the reader). Filters by kind of change, by agenda item or
 * document (and then one of its amendments), by person and by day; they
 * start over the list, «Cargar más» pages it. It follows the live stream.
 */
const props = defineProps<{
  apiBase: string;
  /** The agenda, for the items and documents to filter by. */
  items: readonly AgendaItemDto[];
  documents: readonly DocumentSummaryDto[];
}>();

const { t } = useI18n();
const api = useApi();
const { me } = useMe();
const { onLive } = useCurrentAssembly();
const { memberName } = useActivityMembers();

// Filters ----------------------------------------------------------------------

const groups = ref<ControlSheetActivityGroup[]>([]);
/** "item:<id>" or "document:<id>"; none for the whole sheet. */
const subject = ref<string | undefined>();
/** An amendment of the chosen document; none for all of them. */
const amendmentId = ref<string | undefined>();
const actor = ref<string | undefined>();
const fromDay = ref<string | null>(null);
const toDay = ref<string | null>(null);

watch(subject, () => {
  amendmentId.value = undefined;
});

const groupItems = computed(() =>
  CONTROL_SHEET_ACTIVITY_GROUP_KEYS.map((value) => ({
    value,
    label: t(`controlSheet.history.groups.${value}`),
  })),
);

/** Agenda items with their number, each followed by its documents. */
const subjectItems = computed(() => {
  const unlisted = t("agenda.unlisted.inText");
  const byItem = new Map<string, DocumentSummaryDto[]>();
  for (const document of props.documents) {
    if (document.status === "draft") continue;
    const list = byItem.get(document.agendaItemId) ?? [];
    list.push(document);
    byItem.set(document.agendaItemId, list);
  }
  return flattenAgendaTree(buildAgendaTree([...props.items])).flatMap(
    (node) => [
      {
        value: `item:${node.item.id}`,
        label: numberedAgendaTitle(node.number, node.item.title, unlisted),
      },
      ...(byItem.get(node.item.id) ?? []).map((document) => ({
        value: `document:${document.id}`,
        label: document.title,
        description: t("controlSheet.history.document"),
      })),
    ],
  );
});

const chosenDocumentId = computed(() =>
  subject.value?.startsWith("document:")
    ? subject.value.slice("document:".length)
    : null,
);

/** The amendments of the chosen document, to narrow to one. */
const { data: amendmentsData } = useAsyncData(
  () => `control-sheet-history-amendments-${chosenDocumentId.value ?? "none"}`,
  async () =>
    chosenDocumentId.value
      ? await api.get<DocumentAmendmentsDto>(
          `${props.apiBase}/documents/${encodeURIComponent(chosenDocumentId.value)}/amendments`,
        )
      : null,
  { watch: [chosenDocumentId], server: false, lazy: true },
);
const amendmentItems = computed(() =>
  (amendmentsData.value?.amendments ?? [])
    .filter((amendment) => amendment.status !== "draft")
    .map((amendment) => ({
      value: amendment.id,
      label: amendment.code ?? t("amendment.unnumberedLabel"),
    })),
);

const { data: people } = useAsyncData(
  () => `control-sheet-history-people-${props.apiBase}`,
  () => api.get<UserRef[]>(`${props.apiBase}/control-sheet/activity/people`),
  { server: false, lazy: true, default: () => [] },
);
const peopleItems = computed(() =>
  (people.value ?? []).map((person) => ({
    value: person.id,
    label: person.name,
  })),
);

const query = computed<Record<string, string | undefined>>(() => ({
  group: groups.value.length > 0 ? groups.value.join(",") : undefined,
  subject: amendmentId.value ? `amendment:${amendmentId.value}` : subject.value,
  actor: actor.value,
  // Madrid days, the later one ending the range (activityDateRange).
  ...activityDateRange(fromDay.value, toDay.value),
}));

const activeFilters = computed(
  () =>
    (groups.value.length > 0 ? 1 : 0) +
    (subject.value ? 1 : 0) +
    (actor.value ? 1 : 0) +
    (fromDay.value || toDay.value ? 1 : 0),
);

function clearFilters(): void {
  groups.value = [];
  subject.value = undefined;
  amendmentId.value = undefined;
  actor.value = undefined;
  fromDay.value = null;
  toDay.value = null;
}

// The list ----------------------------------------------------------------------

const {
  items: entries,
  loading,
  refreshing,
  error,
  refresh,
  hasMore,
  loadingMore,
  announcement,
  loadMore,
} = await useActivityPages<ActivityItemDto>({
  key: `control-sheet-history-${props.apiBase}`,
  url: `${props.apiBase}/control-sheet/activity`,
  query,
  keyOf: activityItemKey,
});

/** What the history lists, so a live change of it refetches the first page. */
const historyTypes: ReadonlySet<string> = new Set(
  Object.values(CONTROL_SHEET_ACTIVITY_GROUPS).flat(),
);
onLive((events) => {
  if (
    events.some(
      (event) => event.type === "poll" || historyTypes.has(event.type),
    )
  ) {
    void refresh();
  }
});
</script>

<template>
  <section
    class="flex flex-col gap-4"
    :aria-label="t('controlSheet.history.title')"
  >
    <p class="text-muted text-sm">
      {{ t("controlSheet.history.description") }}
    </p>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <UFormField :label="t('controlSheet.history.filters.groups')">
        <USelectMenu
          v-model="groups"
          :items="groupItems"
          value-key="value"
          multiple
          :search-input="false"
          :placeholder="t('controlSheet.history.filters.allGroups')"
          class="w-full"
        />
      </UFormField>
      <UFormField :label="t('controlSheet.history.filters.subject')">
        <USelectMenu
          v-model="subject"
          :items="subjectItems"
          value-key="value"
          :placeholder="t('controlSheet.history.filters.allSubjects')"
          :search-input="{
            placeholder: t('controlSheet.history.filters.searchSubject'),
          }"
          :ui="{
            value: 'whitespace-normal text-start',
            itemLabel: 'whitespace-normal',
          }"
          class="w-full"
        />
      </UFormField>
      <UFormField :label="t('controlSheet.history.filters.person')">
        <USelectMenu
          v-model="actor"
          :items="peopleItems"
          value-key="value"
          :placeholder="t('controlSheet.history.filters.anyone')"
          :search-input="{
            placeholder: t('controlSheet.history.filters.searchPerson'),
          }"
          class="w-full"
        />
      </UFormField>
      <div class="grid grid-cols-2 gap-2">
        <UFormField :label="t('controlSheet.history.filters.from')">
          <ActivityDayInput
            v-model="fromDay"
            :label="t('controlSheet.history.filters.from')"
            :max="toDay"
          />
        </UFormField>
        <UFormField :label="t('controlSheet.history.filters.to')">
          <ActivityDayInput
            v-model="toDay"
            :label="t('controlSheet.history.filters.to')"
            :min="fromDay"
          />
        </UFormField>
      </div>
      <UFormField
        v-if="chosenDocumentId && amendmentItems.length > 0"
        :label="t('controlSheet.history.filters.amendment')"
      >
        <USelectMenu
          v-model="amendmentId"
          :items="amendmentItems"
          value-key="value"
          :placeholder="t('controlSheet.history.filters.allAmendments')"
          class="w-full"
        />
      </UFormField>
    </div>
    <div v-if="activeFilters > 0">
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-filter-x"
        :label="t('controlSheet.history.filters.clear')"
        @click="clearFilters"
      />
    </div>

    <div v-if="loading" class="space-y-3" role="status">
      <span class="sr-only">{{ t("controlSheet.loading") }}</span>
      <USkeleton
        v-for="n in 4"
        :key="n"
        aria-hidden="true"
        class="h-12 w-full"
      />
    </div>
    <UAlert
      v-else-if="error && entries.length === 0"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('controlSheet.history.loadError')"
      :actions="[
        {
          label: t('controlSheet.retry'),
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
      v-else-if="entries.length === 0"
      icon="i-lucide-history"
      :title="
        activeFilters > 0
          ? t('controlSheet.history.noMatches')
          : t('controlSheet.history.empty')
      "
      variant="outline"
    />
    <div v-else class="flex flex-col gap-4" :aria-busy="refreshing">
      <ActivityTimeline
        :items="entries"
        :self-id="me?.id ?? null"
        show-actor
        :member-name="memberName"
        :class="refreshing ? 'opacity-60' : ''"
      />
      <ActivityLoadMore
        :has-more="hasMore"
        :loading="loadingMore"
        :announcement="announcement"
        :count="entries.length"
        @load="loadMore"
      />
    </div>
  </section>
</template>

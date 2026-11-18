<script setup lang="ts">
import type { TabsItem } from "@nuxt/ui";
import type { AgendaItemDto, SpeakingTurnDto } from "~~/shared/types/api";
import {
  NO_ITEM,
  buildTurnRows,
  filterTurnRows,
  totalTurnSeconds,
  turnItemOptions,
  turnItems,
  turnTotals,
  turnWhoOptions,
  type TurnItem,
  type TurnView,
} from "~/components/control-sheet/-turns";
import { sessionFormatDuration } from "~/composables/session/sessionModel";
import { useAppNow } from "~/composables/time/useAppNow";
import { numberedAgendaTitle } from "~/utils/agendaTree";
import { formatMoment } from "~/utils/format";

/**
 * «Turnos de palabra»: every turn that took the floor in the assembly, in
 * order, with the agenda item it was given in and how long it lasted, or
 * the totals per member («Por interviniente»). Filters by item and by who.
 * The turns come with the sheet (ControlSheetDto.turns, only those of the
 * items the reader gets), so it follows the live stream with it. The one
 * with the floor ticks in the list; the totals count it up to the minute.
 */
const props = defineProps<{
  turns: SpeakingTurnDto[];
  items: AgendaItemDto[];
}>();

const { t, locale } = useI18n();
const now = useAppNow();

const view = ref<TurnView>("list");
const viewItems = computed<TabsItem[]>(() => [
  { value: "list", label: t("controlSheet.turns.views.list") },
  { value: "totals", label: t("controlSheet.turns.views.totals") },
]);

const itemFilter = ref<string | undefined>();
const whoFilter = ref<string | undefined>();
const activeFilters = computed(
  () => Number(Boolean(itemFilter.value)) + Number(Boolean(whoFilter.value)),
);
function clearFilters(): void {
  itemFilter.value = undefined;
  whoFilter.value = undefined;
}

const agendaItems = computed(() => turnItems(props.items));
const rows = computed(() => buildTurnRows(props.turns, agendaItems.value));
const shown = computed(() =>
  filterTurnRows(rows.value, {
    itemId: itemFilter.value ?? null,
    whoKey: whoFilter.value ?? null,
  }),
);
const totals = computed(() => turnTotals(shown.value, now.value));
const totalSeconds = computed(() => totalTurnSeconds(shown.value, now.value));
const anyoneSpeaking = computed(() => shown.value.some((row) => row.speaking));

function itemLabel(item: TurnItem | null): string {
  if (!item) return t("controlSheet.turns.noItem");
  return numberedAgendaTitle(
    item.number,
    item.titleHidden ? t("agenda.hiddenTitle") : item.title,
    t("agenda.unlisted.inText"),
  );
}

const itemOptions = computed(() => {
  const options = turnItemOptions(rows.value, agendaItems.value);
  const entries = options.items.map((item) => ({
    value: item.id,
    label: itemLabel(item),
  }));
  if (options.none) {
    entries.push({ value: NO_ITEM, label: t("controlSheet.turns.noItem") });
  }
  return entries;
});

/** Who a turn is for, as one line: "CEUGR", "ANEM", or the name written. */
function whoLabel(turn: SpeakingTurnDto): string {
  return (
    turn.member?.acronym ??
    (turn.speaker?.trim() || t("liveView.speakers.unnamed"))
  );
}
const whoOptions = computed(() =>
  turnWhoOptions(rows.value).map((option) => ({
    value: option.whoKey,
    label: whoLabel(option.turn),
  })),
);

function started(turn: SpeakingTurnDto): string {
  return turn.startedAt
    ? formatMoment(turn.startedAt, { locale: locale.value, now: now.value })
        .text
    : "";
}

function duration(seconds: number): string {
  return sessionFormatDuration(seconds);
}

const summary = computed(() =>
  t(
    "controlSheet.turns.summary",
    {
      count: shown.value.length,
      time: duration(totalSeconds.value),
    },
    shown.value.length,
  ),
);
</script>

<template>
  <section
    class="flex flex-col gap-4"
    :aria-label="t('controlSheet.turns.title')"
  >
    <p class="text-muted text-sm">
      {{ t("controlSheet.turns.description") }}
    </p>

    <CommonEmptyState
      v-if="rows.length === 0"
      icon="i-lucide-mic"
      :title="t('controlSheet.turns.emptyTitle')"
      :description="t('controlSheet.turns.emptyDescription')"
      variant="outline"
    />

    <template v-else>
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <UFormField :label="t('controlSheet.turns.filters.item')">
          <USelectMenu
            v-model="itemFilter"
            :items="itemOptions"
            value-key="value"
            :placeholder="t('controlSheet.turns.filters.allItems')"
            :search-input="{
              placeholder: t('controlSheet.turns.filters.searchItem'),
            }"
            :ui="{
              value: 'whitespace-normal text-start',
              itemLabel: 'whitespace-normal',
            }"
            class="w-full"
          />
        </UFormField>
        <UFormField :label="t('controlSheet.turns.filters.who')">
          <USelectMenu
            v-model="whoFilter"
            :items="whoOptions"
            value-key="value"
            :placeholder="t('controlSheet.turns.filters.everyone')"
            :search-input="{
              placeholder: t('controlSheet.turns.filters.searchWho'),
            }"
            class="w-full"
          />
        </UFormField>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <UTabs
          v-model="view"
          :items="viewItems"
          :content="false"
          variant="pill"
          size="sm"
          :aria-label="t('controlSheet.turns.views.label')"
        />
        <div class="flex flex-wrap items-center gap-3">
          <UButton
            v-if="activeFilters > 0"
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-filter-x"
            :label="t('controlSheet.turns.filters.clear')"
            @click="clearFilters"
          />
          <p class="text-muted text-sm tabular-nums" role="status">
            {{ summary }}
            <template v-if="anyoneSpeaking">
              · {{ t("controlSheet.turns.ongoing") }}
            </template>
          </p>
        </div>
      </div>

      <CommonEmptyState
        v-if="shown.length === 0"
        icon="i-lucide-search-x"
        :title="t('controlSheet.turns.noMatchesTitle')"
        :description="t('controlSheet.filters.noMatchesDescription')"
        variant="outline"
      >
        <template #action>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-filter-x"
            :label="t('controlSheet.turns.filters.clear')"
            @click="clearFilters"
          />
        </template>
      </CommonEmptyState>

      <!-- Each turn, in the order it took the floor -->
      <div
        v-else-if="view === 'list'"
        class="border-default overflow-x-auto rounded-lg border"
      >
        <table class="w-full min-w-[44rem] text-left text-sm">
          <caption class="sr-only">
            {{
              t("controlSheet.turns.views.list")
            }}
          </caption>
          <thead class="bg-elevated/50 text-muted text-xs">
            <tr>
              <th scope="col" class="w-14 px-3 py-2 text-end font-medium">
                {{ t("controlSheet.turns.columns.index") }}
              </th>
              <th scope="col" class="w-36 px-3 py-2 font-medium">
                {{ t("controlSheet.turns.columns.started") }}
              </th>
              <th scope="col" class="px-3 py-2 font-medium">
                {{ t("controlSheet.turns.columns.item") }}
              </th>
              <th scope="col" class="px-3 py-2 font-medium">
                {{ t("controlSheet.turns.columns.who") }}
              </th>
              <th scope="col" class="w-36 px-3 py-2 text-end font-medium">
                {{ t("controlSheet.turns.columns.duration") }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-default divide-y">
            <tr
              v-for="row in shown"
              :key="row.turn.id"
              :class="row.speaking ? 'bg-primary/5' : undefined"
            >
              <td class="text-muted px-3 py-2 text-end tabular-nums">
                {{ row.index }}
              </td>
              <td class="text-default px-3 py-2 tabular-nums">
                {{ started(row.turn) }}
              </td>
              <td
                class="px-3 py-2"
                :class="row.item ? 'text-default' : 'text-muted'"
              >
                {{ itemLabel(row.item) }}
              </td>
              <td class="text-highlighted px-3 py-2">
                <LiveViewSpeakerName :turn="row.turn" badge-size="sm" />
              </td>
              <td class="px-3 py-2 text-end tabular-nums">
                <span
                  v-if="row.speaking"
                  class="text-highlighted inline-flex items-center gap-1.5 font-medium"
                >
                  <UIcon
                    name="i-lucide-mic"
                    class="text-primary size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span class="sr-only">{{
                    t("controlSheet.turns.speaking")
                  }}</span>
                  <!-- Ticks every second: only in the browser. -->
                  <ClientOnly>
                    <SessionSpeakerTimer :started-at="row.turn.startedAt" />
                  </ClientOnly>
                </span>
                <span v-else-if="row.seconds !== null" class="text-default">
                  {{ duration(row.seconds) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- The totals per member, longest first -->
      <div v-else class="border-default overflow-x-auto rounded-lg border">
        <table class="w-full min-w-[36rem] text-left text-sm">
          <caption class="sr-only">
            {{
              t("controlSheet.turns.views.totals")
            }}
          </caption>
          <thead class="bg-elevated/50 text-muted text-xs">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">
                {{ t("controlSheet.turns.columns.who") }}
              </th>
              <th scope="col" class="w-28 px-3 py-2 text-end font-medium">
                {{ t("controlSheet.turns.columns.turns") }}
              </th>
              <th scope="col" class="w-36 px-3 py-2 text-end font-medium">
                {{ t("controlSheet.turns.columns.total") }}
              </th>
              <th scope="col" class="w-36 px-3 py-2 text-end font-medium">
                {{ t("controlSheet.turns.columns.average") }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-default divide-y">
            <tr v-for="total in totals" :key="total.whoKey">
              <td class="text-highlighted px-3 py-2">
                <span class="inline-flex flex-wrap items-center gap-2">
                  <LiveViewSpeakerName
                    :turn="{ member: total.member, speaker: total.speaker }"
                    badge-size="sm"
                  />
                  <UBadge
                    v-if="total.speaking"
                    color="primary"
                    variant="subtle"
                    size="sm"
                    icon="i-lucide-mic"
                    :label="t('controlSheet.turns.speaking')"
                  />
                </span>
              </td>
              <td class="text-default px-3 py-2 text-end tabular-nums">
                {{ total.turns }}
              </td>
              <td class="text-default px-3 py-2 text-end tabular-nums">
                {{ duration(total.seconds) }}
              </td>
              <td class="text-muted px-3 py-2 text-end tabular-nums">
                {{ duration(Math.round(total.seconds / total.turns)) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

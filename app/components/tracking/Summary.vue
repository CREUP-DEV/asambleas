<script setup lang="ts">
import type { DocumentProgressState } from "~/composables/document/documentProgress";
import {
  TRACKING_STATES,
  type TrackingFilter,
  type TrackingSummary,
} from "./-status";

/**
 * The tracking panel's counts: "En total", "Fuera de plazo" when something
 * is late, and one tile per state that has documents. Empty states are left
 * out so the row stays short on a phone, except the one being filtered, so
 * the pressed tile never disappears under a live update. Each tile is also a
 * filter: pressing it shows only those documents, pressing it again shows
 * them all.
 */
const props = defineProps<{ summary: TrackingSummary }>();

const filter = defineModel<TrackingFilter>({ default: "all" });

const { t } = useI18n();

const ICONS: Record<DocumentProgressState, string> = {
  expected: "i-lucide-file-clock",
  preparing: "i-lucide-file-pen-line",
  correction: "i-lucide-message-square-warning",
  submitted: "i-lucide-send",
  published: "i-lucide-circle-check",
  withdrawn: "i-lucide-archive",
  postponed: "i-lucide-calendar-clock",
};

interface Tile {
  key: TrackingFilter;
  label: string;
  count: number;
  icon: string;
  alert: boolean;
}

const tiles = computed<Tile[]>(() => {
  const list: Tile[] = [
    {
      key: "all",
      label: t("tracking.summary.all", props.summary.total),
      count: props.summary.total,
      icon: "i-lucide-files",
      alert: false,
    },
  ];
  if (props.summary.overdue > 0 || filter.value === "overdue") {
    list.push({
      key: "overdue",
      label: t("tracking.summary.overdue", props.summary.overdue),
      count: props.summary.overdue,
      icon: "i-lucide-alarm-clock",
      alert: true,
    });
  }
  for (const state of TRACKING_STATES) {
    const count = props.summary[state];
    if (count === 0 && filter.value !== state) continue;
    list.push({
      key: state,
      label: t(`tracking.summary.${state}`, count),
      count,
      icon: ICONS[state],
      alert: false,
    });
  }
  return list;
});

function select(key: TrackingFilter) {
  filter.value = filter.value === key && key !== "all" ? "all" : key;
}
</script>

<template>
  <div
    class="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]"
    role="group"
    :aria-label="t('tracking.summary.label')"
  >
    <button
      v-for="tile in tiles"
      :key="tile.key"
      type="button"
      class="flex min-h-16 flex-col items-start justify-between gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
      :class="[
        filter === tile.key
          ? 'border-primary bg-primary/10 ring-primary ring-1'
          : tile.alert
            ? 'border-error/50 bg-error/5 hover:bg-error/10'
            : 'border-default bg-default hover:bg-elevated/60',
      ]"
      :aria-pressed="filter === tile.key"
      @click="select(tile.key)"
    >
      <span
        class="text-2xl leading-none font-semibold tabular-nums"
        :class="tile.alert ? 'text-error' : 'text-highlighted'"
      >
        {{ tile.count }}
      </span>
      <span
        class="flex items-center gap-1 text-xs font-medium"
        :class="tile.alert ? 'text-error' : 'text-muted'"
      >
        <UIcon :name="tile.icon" class="size-3.5 shrink-0" aria-hidden="true" />
        {{ tile.label }}
      </span>
    </button>
  </div>
</template>

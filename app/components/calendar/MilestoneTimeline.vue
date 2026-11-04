<script setup lang="ts">
import type { TimelineItem } from "@nuxt/ui";
import type { MilestoneKey } from "~~/shared/constants/domain";
import type { MilestoneDto } from "~~/shared/types/api";

/**
 * The assembly calendar as a vertical timeline: past milestones completed,
 * the next one highlighted with a countdown, and the assembly itself last.
 */
const props = withDefaults(
  defineProps<{
    milestones: MilestoneDto[];
    /** Assembly start, shown as the closing item of the timeline. */
    startDate?: string | null;
    /** Milestone keys flagged by calendar warnings. */
    warnedKeys?: MilestoneKey[];
    size?: "xs" | "sm" | "md";
  }>(),
  { startDate: null, warnedKeys: () => [], size: "sm" },
);

const { t, locale } = useI18n();

const MILESTONE_ICONS: Record<MilestoneKey, string> = {
  convocation: "i-lucide-megaphone",
  agenda_requests_close: "i-lucide-list-plus",
  agenda_final: "i-lucide-list-checks",
  documents_close: "i-lucide-file-lock",
  documents_publish: "i-lucide-file-check",
  amendments_open: "i-lucide-pencil-line",
  amendments_close: "i-lucide-pencil-off",
  candidacies_close: "i-lucide-user-check",
};

// SSR and hydration agree on "now"; Countdown takes over on the client.
const renderedAt = useState<number>("countdown-rendered-at", () => Date.now());

interface MilestoneItem extends TimelineItem {
  at: string;
  upcoming: boolean;
  next: boolean;
  warned: boolean;
}

const items = computed<MilestoneItem[]>(() => {
  const sorted = [...props.milestones].sort((a, b) => a.at.localeCompare(b.at));
  const now = renderedAt.value;
  const nextIndex = sorted.findIndex(
    (milestone) => new Date(milestone.at).getTime() > now,
  );
  const list: MilestoneItem[] = sorted.map((milestone, index) => ({
    value: milestone.key,
    at: milestone.at,
    date: formatDateTime(milestone.at, { locale: locale.value }),
    title: t(`calendar.milestones.${milestone.key}`),
    description: milestone.note ?? undefined,
    icon: MILESTONE_ICONS[milestone.key],
    upcoming: nextIndex !== -1 && index >= nextIndex,
    next: index === nextIndex,
    warned: props.warnedKeys.includes(milestone.key),
  }));
  if (props.startDate) {
    list.push({
      value: "start",
      at: props.startDate,
      date: formatDateTime(props.startDate, { locale: locale.value }),
      title: t("calendar.assemblyStart"),
      icon: "i-lucide-landmark",
      upcoming: new Date(props.startDate).getTime() > now,
      next: false,
      warned: false,
    });
  }
  return list;
});

/** Index of the next milestone: earlier items show as completed. */
const activeIndex = computed(() => {
  const index = items.value.findIndex((item) => item.upcoming);
  return index === -1 ? items.value.length : index;
});
</script>

<template>
  <div>
    <UTimeline
      v-if="items.length > 0"
      :items="items"
      :default-value="activeIndex"
      :size="props.size"
      color="primary"
    >
      <template #title="{ item }">
        <span class="inline-flex flex-wrap items-center gap-1.5">
          <span>{{ item.title }}</span>
          <UBadge
            v-if="item.next"
            color="primary"
            variant="soft"
            size="sm"
            :label="t('calendar.next')"
          />
          <UTooltip v-if="item.warned" :text="t('calendar.hasWarning')">
            <UIcon
              name="i-lucide-triangle-alert"
              class="text-warning size-4"
              :aria-label="t('calendar.hasWarning')"
              role="img"
            />
          </UTooltip>
        </span>
      </template>
      <template #description="{ item }">
        <span class="block space-y-0.5">
          <CommonCountdown
            v-if="item.upcoming"
            :to="item.at"
            :urgent-hours="72"
            class="text-sm"
          />
          <span v-if="item.description" class="block whitespace-pre-line">{{
            item.description
          }}</span>
        </span>
      </template>
    </UTimeline>
    <CommonEmptyState
      v-else
      icon="i-lucide-calendar-x"
      :title="t('calendar.emptyTitle')"
      :description="t('calendar.emptyDescription')"
      size="sm"
    />
  </div>
</template>

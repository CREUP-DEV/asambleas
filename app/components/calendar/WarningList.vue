<script setup lang="ts">
import type { CalendarWarning } from "~~/shared/utils/calendar";

/**
 * The calendar warnings of checkCalendar, one UAlert each, naming the
 * milestones involved and the minimum of the calendar rules they break.
 * Announced politely when they change. Only the calendar page shows them
 * in full; the overview counts them in one line that links there.
 */
const props = withDefaults(
  defineProps<{
    warnings: CalendarWarning[];
    variant?: "soft" | "subtle" | "outline";
  }>(),
  { variant: "subtle" },
);

const { t } = useI18n();

function limitOf(warning: CalendarWarning): string {
  if (warning.limit) return formatMilestoneOffset(t, warning.limit);
  if (warning.days) return formatMilestoneOffset(t, { days: warning.days });
  return "";
}

const items = computed(() =>
  props.warnings.map((warning, index) => ({
    key: `${warning.code}-${warning.keys.join("-")}-${warning.document?.id ?? ""}-${index}`,
    title: t(`calendar.warnings.${warning.code}`, {
      limit: limitOf(warning),
      document: warning.document?.title ?? "",
    }),
    description: t("calendar.warningMilestones", {
      milestones: warning.keys
        .map((key) => t(`calendar.milestones.${key}`))
        .join(", "),
    }),
  })),
);
</script>

<template>
  <div aria-live="polite" class="space-y-2">
    <UAlert
      v-for="item in items"
      :key="item.key"
      color="warning"
      :variant="props.variant"
      icon="i-lucide-triangle-alert"
      :title="item.title"
      :description="item.description"
    />
  </div>
</template>

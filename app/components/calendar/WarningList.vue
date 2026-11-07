<script setup lang="ts">
import type { CalendarWarning } from "~~/shared/utils/calendar";

/**
 * The calendar warnings of checkCalendar, one UAlert each, naming the
 * milestones involved and the minimum of the calendar rules they break.
 * Announced politely when they change.
 */
const props = withDefaults(
  defineProps<{
    warnings: CalendarWarning[];
    /** Link to the calendar editor, shown when set. */
    editTo?: string;
    variant?: "soft" | "subtle" | "outline";
  }>(),
  { editTo: undefined, variant: "subtle" },
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
      :actions="
        props.editTo
          ? [
              {
                label: t('calendar.reviewCalendar'),
                to: props.editTo,
                color: 'warning',
                variant: 'link',
                trailingIcon: 'i-lucide-arrow-right',
              },
            ]
          : undefined
      "
    />
  </div>
</template>

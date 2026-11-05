<script setup lang="ts">
import { parseDate, type DateValue } from "@internationalized/date";
import { activityDay } from "~/composables/activity/-filters";

/**
 * A day for the activity filters. v-model is "YYYY-MM-DD" or null; the
 * field shows it in the app's language. `min`/`max` keep a range in order.
 */
const props = withDefaults(
  defineProps<{
    id?: string;
    label: string;
    min?: string | null;
    max?: string | null;
  }>(),
  { id: undefined, min: null, max: null },
);

const model = defineModel<string | null>({ default: null });

const { t, locale } = useI18n();

// Date objects of @internationalized/date use private class fields, which
// break behind a reactive proxy: computed values are never proxied.
function toCalendar(day: string | null | undefined) {
  const valid = activityDay(day ?? undefined);
  return valid ? parseDate(valid) : undefined;
}

const value = computed(() => toCalendar(model.value));
const minValue = computed(() => toCalendar(props.min));
const maxValue = computed(() => toCalendar(props.max));

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The field emits one date or nothing (never a range, which its type allows). */
function onUpdate(next: unknown): void {
  if (next && typeof next === "object" && "calendar" in next) {
    const date = next as DateValue;
    model.value = `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}`;
  } else {
    model.value = null;
  }
}
</script>

<template>
  <UInputDate
    :id="props.id"
    :model-value="value"
    :min-value="minValue"
    :max-value="maxValue"
    granularity="day"
    :locale="intlLocale(locale)"
    :aria-label="props.label"
    class="w-full"
    :ui="{ base: 'tabular-nums', trailing: 'pe-1' }"
    @update:model-value="onUpdate"
  >
    <template v-if="model" #trailing>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="link"
        size="xs"
        :aria-label="t('activity.filters.clearDay', { field: props.label })"
        @click="model = null"
      />
    </template>
  </UInputDate>
</template>

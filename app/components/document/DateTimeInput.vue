<script setup lang="ts">
import type { CalendarDateTime, DateValue } from "@internationalized/date";
import { fromAppWallTime, intlLocale, toAppWallTime } from "~/utils/format";

/**
 * Date and time input whose value is an ISO instant, typed and shown as
 * Europe/Madrid wall time whatever the device's time zone (delegates in the
 * Canary Islands see the same hours as the calendar), in the app's language
 * and with 24 hours. Empty means null.
 */
const props = withDefaults(
  defineProps<{
    id?: string;
    name?: string;
    disabled?: boolean;
    /** ISO instant used as the lower bound of the field. */
    min?: string | null;
  }>(),
  {
    id: undefined,
    name: undefined,
    disabled: false,
    min: null,
  },
);

const model = defineModel<string | null>({ default: null });

const { locale } = useI18n();

// Date objects of @internationalized/date use private class fields, which
// break behind a reactive proxy: keep the value in a shallow ref.
const value = shallowRef<CalendarDateTime | undefined>(
  toAppWallTime(model.value),
);

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return !a && !b;
  return new Date(a).getTime() === new Date(b).getTime();
}

watch(model, (next) => {
  // Keep partial typing intact: only resync when the instant really differs.
  if (!sameInstant(fromAppWallTime(value.value), next)) {
    value.value = toAppWallTime(next);
  }
});

/** The field emits one date or nothing (never a range, which its type allows). */
function onUpdate(next: unknown): void {
  const date =
    next && typeof next === "object" && "calendar" in next
      ? (next as DateValue)
      : undefined;
  value.value = date ? toAppWallTime(fromAppWallTime(date)) : undefined;
  model.value = fromAppWallTime(value.value);
}

const minValue = computed(() =>
  props.min ? toAppWallTime(props.min) : undefined,
);
</script>

<template>
  <UInputDate
    :id="id"
    :name="name"
    :model-value="value"
    granularity="minute"
    :hour-cycle="24"
    :locale="intlLocale(locale)"
    :min-value="minValue"
    :disabled="disabled"
    class="w-full"
    @update:model-value="onUpdate"
  />
</template>

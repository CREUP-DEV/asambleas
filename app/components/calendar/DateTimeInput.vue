<script setup lang="ts">
import type { CalendarDateTime, DateValue } from "@internationalized/date";
import { fromAppWallTime, intlLocale, toAppWallTime } from "~/utils/format";

/**
 * Date and time input in the assemblies' time zone. v-model is an ISO
 * instant or null; the field shows and accepts Europe/Madrid wall time,
 * whatever the browser's time zone (a delegate abroad sees and types Spanish
 * peninsular time, like everyone), in the app's language and with 24 hours.
 */
const props = withDefaults(
  defineProps<{
    id?: string;
    disabled?: boolean;
    required?: boolean;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    /** Highlights the field (e.g. a calendar warning points at it). */
    invalid?: boolean;
  }>(),
  {
    id: undefined,
    disabled: false,
    required: false,
    size: "md",
    invalid: false,
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
function onUpdate(next: unknown) {
  const date =
    next && typeof next === "object" && "calendar" in next
      ? (next as DateValue)
      : undefined;
  value.value = date ? toAppWallTime(fromAppWallTime(date)) : undefined;
  model.value = fromAppWallTime(value.value);
}
</script>

<template>
  <UInputDate
    :id="props.id"
    :model-value="value"
    granularity="minute"
    :hour-cycle="24"
    :locale="intlLocale(locale)"
    :disabled="props.disabled"
    :required="props.required"
    :size="props.size"
    :color="props.invalid ? 'warning' : undefined"
    :highlight="props.invalid"
    class="w-full"
    :ui="{ base: 'tabular-nums' }"
    @update:model-value="onUpdate"
  />
</template>

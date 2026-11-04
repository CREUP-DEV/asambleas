<script lang="ts">
import {
  parseAbsolute,
  parseDateTime,
  toCalendarDateTime,
  toZoned,
} from "@internationalized/date";
import { APP_TIME_ZONE } from "~/utils/format";

const LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** ISO instant -> "YYYY-MM-DDTHH:mm" wall time in Europe/Madrid. */
export function isoToMadridInput(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return toCalendarDateTime(parseAbsolute(value, APP_TIME_ZONE))
      .toString()
      .slice(0, 16);
  } catch {
    return "";
  }
}

/** "YYYY-MM-DDTHH:mm" wall time in Europe/Madrid -> ISO instant. */
export function madridInputToIso(value: string): string | null {
  if (!LOCAL_PATTERN.test(value)) return null;
  try {
    return toZoned(parseDateTime(value.slice(0, 16)), APP_TIME_ZONE)
      .toDate()
      .toISOString();
  } catch {
    return null;
  }
}
</script>

<script setup lang="ts">
/**
 * Date and time input whose value is an ISO instant, typed and shown as
 * Europe/Madrid wall time whatever the device's time zone (delegates in the
 * Canary Islands see the same hours as the calendar). Empty means null.
 */
const props = withDefaults(
  defineProps<{
    id?: string;
    name?: string;
    disabled?: boolean;
    /** ISO instant used as the lower bound of the picker. */
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

const local = ref(isoToMadridInput(model.value));

watch(model, (value) => {
  // Keep partial typing intact: only resync when the instant really differs.
  if (madridInputToIso(local.value) !== (value ?? null)) {
    local.value = isoToMadridInput(value);
  }
});

function onInput(value: string | number | null | undefined): void {
  const text = typeof value === "string" ? value : "";
  local.value = text;
  if (!text) {
    model.value = null;
    return;
  }
  const iso = madridInputToIso(text);
  if (iso) model.value = iso;
}

const minLocal = computed(() =>
  props.min ? isoToMadridInput(props.min) : undefined,
);
</script>

<template>
  <UInput
    :id="id"
    :name="name"
    :model-value="local"
    type="datetime-local"
    :min="minLocal"
    :disabled="disabled"
    class="w-full"
    @update:model-value="onInput"
  />
</template>

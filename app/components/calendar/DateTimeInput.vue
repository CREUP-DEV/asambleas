<script lang="ts">
import { APP_TIME_ZONE, toDate, type DateInput } from "~/utils/format";

/**
 * Date-time conversions between ISO instants and the wall time of the
 * assemblies' time zone (Europe/Madrid), as used by
 * `<input type="datetime-local">`. The browser's own time zone never matters:
 * a delegate abroad sees and types Spanish peninsular time, like everyone.
 */

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function zonedParts(date: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return parts;
}

/** Offset of the time zone at an instant, in ms (wall time minus UTC). */
function zoneOffset(utcMs: number): number {
  const truncated = Math.floor(utcMs / 60_000) * 60_000;
  const parts = zonedParts(new Date(truncated));
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
  return wall - truncated;
}

/** ISO instant to "YYYY-MM-DDTHH:mm" in Europe/Madrid ("" when empty). */
export function toZonedInputValue(value: DateInput): string {
  const date = toDate(value);
  if (!date) return "";
  const parts = zonedParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** "YYYY-MM-DDTHH:mm" in Europe/Madrid to an ISO instant (null if invalid). */
export function fromZonedInputValue(
  value: string | null | undefined,
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const wall = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  if (Number.isNaN(wall)) return null;
  // Two passes settle the offset around daylight-saving changes.
  let utc = wall - zoneOffset(wall);
  utc = wall - zoneOffset(utc);
  return new Date(utc).toISOString();
}
</script>

<script setup lang="ts">
/**
 * Date and time input in the assemblies' time zone. v-model is an ISO
 * instant or null; the field shows and accepts Europe/Madrid wall time.
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

const text = ref(toZonedInputValue(model.value));

watch(model, (value) => {
  const next = toZonedInputValue(value);
  if (
    fromZonedInputValue(text.value) !==
    (value ? toDate(value)?.toISOString() : null)
  ) {
    text.value = next;
  }
});

function onInput(value: string | number | null | undefined) {
  text.value = value === null || value === undefined ? "" : String(value);
  model.value = fromZonedInputValue(text.value);
}
</script>

<template>
  <UInput
    :id="props.id"
    :model-value="text"
    type="datetime-local"
    :disabled="props.disabled"
    :required="props.required"
    :size="props.size"
    :color="props.invalid ? 'warning' : undefined"
    :highlight="props.invalid"
    class="w-full"
    :ui="{ base: 'tabular-nums' }"
    @update:model-value="onInput"
  />
</template>

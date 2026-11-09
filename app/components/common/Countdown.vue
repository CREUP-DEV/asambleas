<script setup lang="ts">
import type { DateInput } from "~/utils/format";

/**
 * Relative time to (or since) a date: "dentro de 3 días", "hace 2 horas".
 * Follows the app's shared clock (useAppNow, every minute on the minute),
 * announces changes politely, and shows the absolute date (Europe/Madrid)
 * as a tooltip and in `datetime`.
 *
 * `urgent` turns on within `urgentHours` of the date; `expired` is emitted
 * once when the date passes while the component is mounted.
 */
const props = withDefaults(
  defineProps<{
    to: DateInput;
    /** Hours before the date when the countdown turns urgent. */
    urgentHours?: number;
    /** Optional prefix, e.g. "Cierra". */
    label?: string;
    icon?: string;
    /** "day" counts days instead of weeks or months ("dentro de 35 días"). */
    maxUnit?: "day";
  }>(),
  { urgentHours: 24, label: undefined, icon: undefined, maxUnit: undefined },
);

const emit = defineEmits<{ expired: [] }>();

const { locale } = useI18n();

// SSR and hydration share the render time so the text matches; the shared
// clock moves on once the app is hydrated.
const now = useAppNow();

const target = computed(() => toDate(props.to));
const iso = computed(() => target.value?.toISOString());
const absolute = computed(() =>
  formatDateTime(target.value, { locale: locale.value, style: "long" }),
);
const relative = computed(() =>
  formatRelative(target.value, {
    locale: locale.value,
    now: now.value,
    maxUnit: props.maxUnit,
  }),
);
const remainingMs = computed(() =>
  target.value ? target.value.getTime() - now.value : 0,
);
const past = computed(() => Boolean(target.value) && remainingMs.value <= 0);
const urgent = computed(
  () =>
    !past.value &&
    Boolean(target.value) &&
    remainingMs.value <= props.urgentHours * 3_600_000,
);

watch(past, (isPast, wasPast) => {
  if (isPast && wasPast === false) emit("expired");
});
</script>

<template>
  <span
    v-if="target"
    class="inline-flex items-baseline gap-1 tabular-nums"
    :class="{
      'text-warning': urgent,
      'text-muted': past,
    }"
    aria-live="polite"
    aria-atomic="true"
  >
    <!--
      The icon sits in a box one line tall at the top, so it stays centred
      on the first line when a long label wraps; it takes no part in the
      baseline, so the countdown lines up with the text around it.
    -->
    <span v-if="icon" class="flex h-[1lh] shrink-0 items-center self-start">
      <UIcon :name="icon" class="size-4" aria-hidden="true" />
    </span>
    <!-- Label and time wrap together, as text. -->
    <span class="min-w-0">
      {{ label ? `${label} ` : "" }}
      <time :datetime="iso" :title="absolute">{{ relative }}</time>
    </span>
  </span>
</template>

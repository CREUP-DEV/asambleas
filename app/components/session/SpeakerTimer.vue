<script setup lang="ts">
import {
  sessionElapsedSeconds,
  sessionFormatDuration,
} from "~/composables/session/sessionModel";

/**
 * How long the current speaker has had the floor, ticking every second.
 * Only mounted while someone speaks, so the clock runs only then. It is a
 * timer, not a live region: screen readers read it when asked, never on
 * every tick.
 */
const props = defineProps<{ startedAt: string | null }>();

const { t } = useI18n();
const now = useNow({ interval: 1000 });

const text = computed(() =>
  sessionFormatDuration(
    sessionElapsedSeconds(props.startedAt, now.value.getTime()),
  ),
);
</script>

<template>
  <span
    role="timer"
    aria-live="off"
    class="tabular-nums"
    :aria-label="t('session.speakers.elapsed', { time: text })"
  >
    {{ text }}
  </span>
</template>

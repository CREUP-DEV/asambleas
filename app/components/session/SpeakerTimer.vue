<script setup lang="ts">
import { sessionElapsedSeconds } from "~/composables/session/sessionModel";
import { turnClock } from "~/composables/session/turnClock";

/**
 * How long the current speaker has had the floor, ticking every second.
 * With a limit (`limitSeconds`) it counts down instead and, past it, counts
 * the time over ("+0:12") inside a pulsing red ring, the digits keeping
 * their colour. Only mounted while someone speaks, so the clock runs only
 * then. It is a timer, not a live region: screen readers read it when
 * asked, never on every tick.
 */
const props = defineProps<{
  startedAt: string | null;
  limitSeconds?: number | null;
}>();

const { t } = useI18n();
const now = useNow({ interval: 1000 });

const clock = computed(() =>
  turnClock(
    sessionElapsedSeconds(props.startedAt, now.value.getTime()),
    props.limitSeconds,
  ),
);

const label = computed(() => {
  if (clock.value.overtime) {
    return t("session.speakers.overtime", { time: clock.value.text });
  }
  return clock.value.remaining === null
    ? t("session.speakers.elapsed", { time: clock.value.text })
    : t("session.speakers.remaining", { time: clock.value.text });
});
</script>

<template>
  <span
    role="timer"
    aria-live="off"
    class="tabular-nums"
    :class="
      clock.overtime
        ? 'ring-error bg-error/10 rounded-md px-[0.25em] ring-2 motion-safe:animate-pulse'
        : undefined
    "
    :aria-label="label"
    :data-overtime="clock.overtime ? 'true' : undefined"
  >
    {{ clock.text }}
  </span>
</template>

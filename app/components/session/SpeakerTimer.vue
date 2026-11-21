<script setup lang="ts">
import { sessionElapsedSeconds } from "~/composables/session/sessionModel";
import { turnClock, turnClockReserve } from "~/composables/session/turnClock";

/**
 * How long the current speaker has had the floor, ticking every second.
 * With a limit (`limitSeconds`) it counts down instead and, past it, counts
 * the time over ("+0:12") inside a pulsing red ring, the digits keeping
 * their colour. Only mounted while someone speaks, so the clock runs only
 * then. It is a timer, not a live region: screen readers read it when
 * asked, never on every tick.
 *
 * Its digits keep one width (CommonTabularDigits: Raleway has no tabular
 * figures), and a turn with a limit keeps the ring's padding all along, so
 * the clock does not shake as it ticks nor jump when the time runs out.
 * With `reserve` (the projection) it also takes from the start the room of
 * its widest text (turnClockReserve), right-aligned, so nothing beside it
 * moves when it reaches the time over.
 */
const props = defineProps<{
  startedAt: string | null;
  limitSeconds?: number | null;
  reserve?: boolean;
}>();

const { t } = useI18n();
const now = useNow({ interval: 1000 });

const clock = computed(() =>
  turnClock(
    sessionElapsedSeconds(props.startedAt, now.value.getTime()),
    props.limitSeconds,
  ),
);
const limited = computed(() => Boolean(props.limitSeconds));
const reserveText = computed(() => turnClockReserve(props.limitSeconds));
/**
 * On the projection the clock sits alone beside its icon: its box is
 * trimmed to the capitals so the icon centres on the digits (AGENTS.md,
 * as the projection's own clock), with a little room for the ring.
 */
const trim = computed(() => {
  if (!props.reserve) return undefined;
  return limited.value
    ? "py-[0.15em] [text-box:trim-both_cap_alphabetic]"
    : "[text-box:trim-both_cap_alphabetic]";
});

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
    class="inline-grid"
    :aria-label="label"
    :data-overtime="clock.overtime ? 'true' : undefined"
  >
    <span
      v-if="reserve"
      class="invisible [grid-area:1/1]"
      :class="[limited ? 'px-[0.25em]' : undefined, trim]"
      aria-hidden="true"
    >
      <CommonTabularDigits :text="reserveText" />
    </span>
    <span
      class="justify-self-end [grid-area:1/1]"
      :class="[
        limited ? 'rounded-md px-[0.25em]' : undefined,
        trim,
        clock.overtime
          ? 'ring-error bg-error/10 ring-2 motion-safe:animate-pulse'
          : undefined,
      ]"
    >
      <CommonTabularDigits :text="clock.text" />
    </span>
  </span>
</template>

<script setup lang="ts">
import {
  fittingCount,
  LIVE_SPEAKERS_NEXT,
  type LiveSpeakers,
} from "~/components/live-view/-model";

/**
 * Who has the floor, for how long, and who speaks next, as the Mesa wrote
 * them down. Only rendered while the Mesa makes the turns visible (see
 * liveSpeakers).
 *
 * `size="projection"` is the band at the bottom of the projection screen,
 * two lines at most (user's decision of 2026-11-21): who has the floor,
 * their name cut on one line; below, after «Después:», the acronyms of as
 * many waiting turns as fit on the line (fittingCount, measured after
 * layout; the page passes up to PROJECTION_SPEAKERS_MAX), then «y N más».
 * The clock stands to the right of both lines, as tall as the two together
 * (user's decision of 2026-11-21), in a slot that keeps its width
 * (SessionSpeakerTimer `reserve`): the queue's line is shorter for it, so
 * fewer acronyms fit.
 * The heading is for screen readers only, and nothing says who has the
 * floor while nobody does (the page leaves the band out when nobody is
 * waiting either).
 */
const props = withDefaults(
  defineProps<{
    speakers: LiveSpeakers;
    size?: "default" | "projection";
    headingLevel?: 2 | 3;
    /** Id of the heading, for aria-labelledby. */
    headingId?: string;
  }>(),
  { size: "default", headingLevel: 2, headingId: "live-speakers-title" },
);

const { t } = useI18n();

const projection = computed(() => props.size === "projection");
const headingTag = computed(() => `h${props.headingLevel}`);

// The projection's queue: as many acronyms as fit on one line -----------------

const queue = ref<HTMLElement | null>(null);
const moreProbe = ref<HTMLElement | null>(null);
/** Waiting turns shown on the line; the rest go into «y N más». */
const shown = ref(LIVE_SPEAKERS_NEXT);
/** Every waiting turn: the ones passed and those the page left out. */
const waitingTotal = computed(
  () => props.speakers.next.length + props.speakers.more,
);
const hiddenCount = computed(
  () =>
    Math.max(0, props.speakers.next.length - shown.value) + props.speakers.more,
);

/**
 * Measures the chips (all rendered, the ones left out invisible behind the
 * label) and keeps as many as fit with room for «y N más», measured with
 * the widest count it may say (`moreProbe`). Hiding a chip does not change
 * the list's width, so this never feeds back into its own observer.
 */
let queueFrame = 0;
function fitQueue(): void {
  if (!import.meta.client || !projection.value || queueFrame) return;
  queueFrame = requestAnimationFrame(() => {
    queueFrame = 0;
    const list = queue.value;
    if (!list) return;
    const chips = Array.from(list.querySelectorAll<HTMLElement>("[data-chip]"));
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    shown.value = fittingCount(
      chips.map((chip) => chip.getBoundingClientRect().width),
      gap,
      list.clientWidth,
      moreProbe.value?.getBoundingClientRect().width ?? 0,
      waitingTotal.value,
    );
  });
}
watch(
  () => [
    props.speakers.next.map((turn) => turn.id).join(),
    props.speakers.more,
    queue.value,
  ],
  fitQueue,
  { flush: "post" },
);
// The window was resized.
useResizeObserver(queue, fitQueue);
onMounted(() => {
  fitQueue();
  // Raleway may land after the first layout and widen the acronyms.
  void window.document.fonts?.ready.then(fitQueue);
});
onBeforeUnmount(() => {
  if (queueFrame) cancelAnimationFrame(queueFrame);
});
</script>

<template>
  <section
    :aria-labelledby="headingId"
    :class="
      projection
        ? 'border-primary/40 bg-primary/5 flex flex-col gap-y-[clamp(0.25rem,0.4vw,0.5rem)] rounded-2xl border-2 px-[clamp(1rem,2vw,2rem)] py-[clamp(0.25rem,0.6vw,0.625rem)]'
        : 'flex flex-col gap-3'
    "
  >
    <component
      :is="headingTag"
      :id="headingId"
      :class="projection ? 'sr-only' : 'text-highlighted text-lg font-semibold'"
    >
      {{ t("liveView.speakers.title") }}
    </component>

    <!-- Phone and desktop: one card, the queue below -->
    <div
      v-if="!projection"
      class="ring-default flex flex-col gap-4 rounded-lg p-4 ring"
    >
      <div class="flex flex-col gap-1">
        <p class="text-muted text-sm font-medium">
          {{ t("liveView.speakers.current") }}
        </p>
        <p
          v-if="speakers.current"
          class="text-highlighted flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold"
        >
          <LiveViewSpeakerName :turn="speakers.current" badge-size="lg" />
          <!-- Ticks every second: only in the browser. -->
          <ClientOnly>
            <span
              v-if="speakers.current.startedAt"
              class="text-muted inline-flex items-center gap-1.5 font-medium"
            >
              <UIcon
                :name="
                  speakers.current.limitSeconds
                    ? 'i-lucide-hourglass'
                    : 'i-lucide-timer'
                "
                class="size-5 shrink-0"
                aria-hidden="true"
              />
              <SessionSpeakerTimer
                :started-at="speakers.current.startedAt"
                :limit-seconds="speakers.current.limitSeconds"
              />
            </span>
          </ClientOnly>
        </p>
        <p v-else class="text-muted">
          {{ t("liveView.speakers.empty") }}
        </p>
      </div>

      <div
        v-if="speakers.next.length > 0"
        class="border-default flex flex-col gap-2 border-t pt-3"
      >
        <p class="text-muted text-sm font-medium">
          {{ t("liveView.speakers.next") }}
        </p>
        <ol class="flex flex-col gap-2">
          <li
            v-for="(turn, index) in speakers.next"
            :key="turn.id"
            class="text-default flex min-w-0 items-center gap-2"
          >
            <span
              class="text-muted w-5 shrink-0 text-end tabular-nums"
              aria-hidden="true"
              >{{ index + 1 }}.</span
            >
            <LiveViewSpeakerName :turn="turn" />
          </li>
        </ol>
        <p v-if="speakers.more > 0" class="text-muted text-sm">
          {{
            t("liveView.speakers.more", { count: speakers.more }, speakers.more)
          }}
        </p>
      </div>
    </div>

    <div v-else class="flex min-w-0 items-center gap-x-[clamp(1rem,2vw,2rem)]">
      <!-- Projection: one band, two lines at most. Nobody with the floor says
           nothing: the screen keeps that room for the document and the
           agenda. -->
      <div
        class="flex min-w-0 flex-1 flex-col gap-y-[clamp(0.25rem,0.4vw,0.5rem)]"
      >
        <div
          v-if="speakers.current"
          class="flex min-w-0 items-center gap-x-[clamp(0.75rem,1.5vw,1.5rem)]"
        >
          <span
            class="text-muted shrink-0 text-[clamp(1rem,1.4vw,1.5rem)] font-medium"
          >
            {{ t("liveView.speakers.current") }}
          </span>
          <span
            class="text-highlighted flex min-w-0 flex-1 text-[clamp(1.5rem,2.8vw,3.25rem)] leading-tight font-bold"
          >
            <LiveViewSpeakerName
              :turn="speakers.current"
              badge-size="xl"
              :tooltip="false"
              truncate
            />
          </span>
        </div>

        <div
          v-if="speakers.next.length > 0"
          class="relative flex min-w-0 items-center gap-x-[clamp(0.75rem,1.5vw,1.5rem)] leading-tight"
        >
          <span
            class="text-muted shrink-0 text-[clamp(1rem,1.4vw,1.5rem)] font-medium"
          >
            {{ t("liveView.speakers.nextInline") }}
          </span>
          <!-- Every chip stays rendered to be measured (fitQueue); the ones
             that do not fit go invisible behind «y N más» (`order`). -->
          <ol
            ref="queue"
            class="flex min-w-0 flex-1 flex-nowrap items-center gap-x-[clamp(0.5rem,1vw,1rem)] overflow-hidden text-[clamp(1.125rem,1.6vw,1.75rem)] font-semibold"
          >
            <li
              v-for="(turn, index) in speakers.next"
              :key="turn.id"
              data-chip
              class="flex shrink-0"
              :class="index < shown ? undefined : 'invisible order-2'"
            >
              <CommonMemberBadge
                v-if="turn.member"
                :member="turn.member"
                size="lg"
                :tooltip="false"
              />
              <span v-else class="text-default whitespace-nowrap">
                {{ turn.speaker?.trim() || t("liveView.speakers.unnamed") }}
              </span>
            </li>
            <li
              v-if="hiddenCount > 0"
              class="text-muted order-1 shrink-0 text-[clamp(1rem,1.4vw,1.5rem)] font-medium whitespace-nowrap"
            >
              {{
                t("liveView.speakers.more", { count: hiddenCount }, hiddenCount)
              }}
            </li>
          </ol>
          <!-- The widest «y N más» it may say, to leave room for it. -->
          <span
            ref="moreProbe"
            class="invisible absolute start-0 top-0 text-[clamp(1rem,1.4vw,1.5rem)] font-medium whitespace-nowrap"
            aria-hidden="true"
          >
            {{
              t("liveView.speakers.more", { count: waitingTotal }, waitingTotal)
            }}
          </span>
        </div>
      </div>

      <!-- The clock, beside both lines and as tall as they are. Ticks every
           second: only in the browser. -->
      <ClientOnly>
        <span
          v-if="speakers.current?.startedAt"
          class="border-primary/30 text-muted inline-flex shrink-0 items-center gap-[0.25em] self-stretch border-s-2 ps-[clamp(1rem,2vw,2rem)] text-[clamp(2.75rem,5.2vw,6rem)] leading-none font-semibold"
        >
          <UIcon
            :name="
              speakers.current.limitSeconds
                ? 'i-lucide-hourglass'
                : 'i-lucide-timer'
            "
            class="size-[0.75em] shrink-0"
            aria-hidden="true"
          />
          <SessionSpeakerTimer
            :started-at="speakers.current.startedAt"
            :limit-seconds="speakers.current.limitSeconds"
            reserve
          />
        </span>
      </ClientOnly>
    </div>
  </section>
</template>

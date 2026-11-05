<script setup lang="ts">
import type { LiveSpeakers } from "~/components/live-view/-model";

/**
 * Who has the floor and who speaks next, as the Mesa wrote them down. Only
 * rendered while the Mesa makes the turns visible (see liveSpeakers).
 *
 * `size="projection"` is the band at the bottom of the projection screen:
 * large type, the queue on one line, the heading for screen readers only.
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
</script>

<template>
  <section
    :aria-labelledby="headingId"
    :class="
      projection
        ? 'border-primary/40 bg-primary/5 flex flex-wrap items-center gap-x-[clamp(1.5rem,3vw,3rem)] gap-y-2 rounded-2xl border-2 px-[clamp(1rem,2vw,2rem)] py-[clamp(0.5rem,1vw,1rem)]'
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
          class="text-highlighted text-xl font-semibold"
        >
          <LiveViewSpeakerName
            :turn="speakers.current"
            badge-size="lg"
            strong
          />
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

    <!-- Projection: one band -->
    <template v-else>
      <div class="min-w-0">
        <p class="text-muted text-[clamp(1rem,1.4vw,1.5rem)] font-medium">
          {{ t("liveView.speakers.current") }}
        </p>
        <p
          v-if="speakers.current"
          class="text-highlighted text-[clamp(1.5rem,2.8vw,3.25rem)] leading-tight font-bold"
        >
          <LiveViewSpeakerName
            :turn="speakers.current"
            badge-size="xl"
            strong
          />
        </p>
        <p v-else class="text-muted text-[clamp(1.25rem,2vw,2.25rem)]">
          {{ t("liveView.speakers.empty") }}
        </p>
      </div>

      <div v-if="speakers.next.length > 0" class="min-w-0 flex-1">
        <p class="text-muted text-[clamp(1rem,1.4vw,1.5rem)] font-medium">
          {{ t("liveView.speakers.next") }}
        </p>
        <ol
          class="flex flex-wrap items-center gap-x-[clamp(1rem,2vw,2rem)] gap-y-1 text-[clamp(1.125rem,1.8vw,2rem)] font-semibold"
        >
          <li v-for="turn in speakers.next" :key="turn.id" class="min-w-0">
            <LiveViewSpeakerName :turn="turn" badge-size="lg" />
          </li>
          <li
            v-if="speakers.more > 0"
            class="text-muted text-[clamp(1rem,1.4vw,1.5rem)] font-medium"
          >
            {{
              t(
                "liveView.speakers.more",
                { count: speakers.more },
                speakers.more,
              )
            }}
          </li>
        </ol>
      </div>
    </template>
  </section>
</template>

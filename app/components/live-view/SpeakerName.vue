<script setup lang="ts">
import type { SpeakingTurnDto } from "~~/shared/types/api";

/**
 * One speaking turn: the member it speaks for (acronym badge, full name for
 * screen readers) and the person's name when the Mesa wrote it, or else the
 * member's name. The text inherits the size of its container, so the same
 * markup serves the phone view and the projection.
 */
const props = withDefaults(
  defineProps<{
    turn: Pick<SpeakingTurnDto, "member" | "speaker">;
    badgeSize?: "sm" | "md" | "lg" | "xl";
    /** Solid badge, for the one who has the floor. */
    strong?: boolean;
  }>(),
  { badgeSize: "md", strong: false },
);

const { t } = useI18n();

const speaker = computed(() => props.turn.speaker?.trim() || null);
</script>

<template>
  <span class="inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-2">
    <CommonMemberBadge
      v-if="turn.member"
      :member="turn.member"
      :size="badgeSize"
      :variant="strong ? 'solid' : 'subtle'"
    />
    <span v-if="speaker" class="min-w-0 break-words">{{ speaker }}</span>
    <!-- The badge already gives screen readers the member's name; a name
         that only repeats the acronym is not shown twice. -->
    <template v-else-if="turn.member">
      <span
        v-if="!memberNameRepeatsAcronym(turn.member)"
        class="min-w-0 break-words"
        aria-hidden="true"
      >
        {{ turn.member.name }}
      </span>
    </template>
    <span v-else class="text-muted font-medium">
      {{ t("liveView.speakers.unnamed") }}
    </span>
  </span>
</template>

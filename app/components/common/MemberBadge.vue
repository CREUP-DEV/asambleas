<script setup lang="ts">
import type { MemberKind } from "~~/shared/constants/domain";
import type { MemberRef } from "~~/shared/types/api";

/**
 * A member (student council, sectorial, executive area) shown by its acronym,
 * with the full name in a tooltip. Screen readers get the full name instead
 * of the acronym.
 */
const props = withDefaults(
  defineProps<{
    member: Pick<MemberRef, "acronym" | "name"> &
      Partial<Pick<MemberRef, "kind">>;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    variant?: "solid" | "outline" | "soft" | "subtle";
    /** Shows the full name next to the acronym. */
    showName?: boolean;
  }>(),
  { size: "sm", variant: "subtle", showName: false },
);

const KIND_COLORS: Record<
  MemberKind,
  "secondary" | "info" | "primary" | "neutral"
> = {
  asociado: "secondary",
  sectorial: "info",
  executive: "primary",
  other: "neutral",
};

const color = computed(() =>
  props.member.kind ? KIND_COLORS[props.member.kind] : "neutral",
);
const tooltipDisabled = computed(
  () => props.showName || props.member.name === props.member.acronym,
);
</script>

<template>
  <span class="inline-flex max-w-full min-w-0 items-center gap-1.5">
    <UTooltip :text="member.name" :disabled="tooltipDisabled">
      <UBadge
        :color="color"
        :variant="variant"
        :size="size"
        class="shrink-0 font-semibold tracking-wide"
      >
        <span :aria-hidden="showName ? undefined : 'true'">{{
          member.acronym
        }}</span>
        <span v-if="!showName" class="sr-only">{{ member.name }}</span>
      </UBadge>
    </UTooltip>
    <span v-if="showName" class="text-default min-w-0 truncate text-sm">
      {{ member.name }}
    </span>
  </span>
</template>

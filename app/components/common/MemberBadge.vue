<script setup lang="ts">
import type { MemberKind } from "~~/shared/constants/domain";
import type { MemberRef } from "~~/shared/types/api";

/**
 * A member (student council, sectorial, executive office) shown by its acronym,
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

/**
 * Councils in blue, sectorials in their own green (`sectorial`, main.css),
 * everyone else (the CEA's offices, the CAS and any other) in the grey-blue
 * of `secondary`.
 */
const KIND_COLORS: Record<MemberKind, "info" | "sectorial" | "secondary"> = {
  asociado: "info",
  sectorial: "sectorial",
  executive: "secondary",
  other: "secondary",
};

const color = computed(() =>
  props.member.kind ? KIND_COLORS[props.member.kind] : "secondary",
);
/** A name that only repeats the acronym is not shown twice. */
const nameRepeats = computed(() => memberNameRepeatsAcronym(props.member));
const tooltipDisabled = computed(() => props.showName || nameRepeats.value);
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
        <span :aria-hidden="showName || nameRepeats ? undefined : 'true'">{{
          member.acronym
        }}</span>
        <span v-if="!showName && !nameRepeats" class="sr-only">{{
          member.name
        }}</span>
      </UBadge>
    </UTooltip>
    <span
      v-if="showName && !nameRepeats"
      class="text-default min-w-0 truncate text-sm"
    >
      {{ member.name }}
    </span>
  </span>
</template>

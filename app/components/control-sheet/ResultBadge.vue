<script setup lang="ts">
import type { ControlSheetResult } from "~~/shared/utils/controlSheet";

/**
 * The result of a row of «General»: the outcome of its votes, or what
 * happened to its documents. Null reads «Pendiente».
 */
const props = defineProps<{
  result: ControlSheetResult | null;
}>();

const { t } = useI18n();

const COLORS: Record<
  ControlSheetResult,
  "success" | "error" | "warning" | "neutral" | "secondary"
> = {
  approved: "success",
  approved_unanimous: "success",
  rejected: "error",
  mixed: "secondary",
  withdrawn: "neutral",
  // Grey, so neither looks like «Pendiente» (amber).
  lapsed: "neutral",
  postponed: "neutral",
  not_applicable: "neutral",
};

/** «Pendiente» in amber: nothing settled yet. */
const color = computed(() => (props.result ? COLORS[props.result] : "warning"));
</script>

<template>
  <UBadge
    :color="color"
    variant="subtle"
    size="md"
    class="whitespace-nowrap"
    :label="t(`controlSheet.result.${result ?? 'pending'}`)"
  />
</template>

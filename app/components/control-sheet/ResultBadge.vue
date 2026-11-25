<script setup lang="ts">
import type { ControlSheetResult } from "~~/shared/utils/controlSheet";
import { CONTROL_SHEET_RESULT_COLORS } from "~/utils/statusColors";

/**
 * The result of a row of «General»: the outcome of its votes, or what
 * happened to its documents. Null reads «Pendiente».
 */
const props = defineProps<{
  result: ControlSheetResult | null;
}>();

const { t } = useI18n();

/** «Pendiente» (null) in amber: nothing settled yet. */
const color = computed(
  () => CONTROL_SHEET_RESULT_COLORS[props.result ?? "pending"],
);
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

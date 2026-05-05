<script setup lang="ts">
import type { AssemblyStatus } from "~~/shared/constants/statuses";

const props = defineProps<{
  status: AssemblyStatus;
}>();

const { t } = useI18n();

const colorMap: Record<AssemblyStatus, "neutral" | "warning" | "success"> = {
  draft: "neutral",
  provisional: "warning",
  definitive: "success",
};

const iconMap: Record<AssemblyStatus, string> = {
  draft: "i-tabler-pencil",
  provisional: "i-tabler-clock",
  definitive: "i-tabler-circle-check",
};
</script>

<template>
  <UBadge
    :color="colorMap[props.status]"
    :label="t(`assembly.statuses.${props.status}`)"
    :icon="iconMap[props.status]"
    variant="subtle"
  />
</template>

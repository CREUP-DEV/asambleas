<script setup lang="ts">
/**
 * How much of something was read: "12 de 30", a thin bar, and how many were
 * read on an earlier revision. Admin statistics only.
 */
const props = defineProps<{
  read: number;
  changed: number;
  total: number;
}>();

const { t } = useI18n();

const share = computed(() =>
  props.total > 0 ? Math.round((props.read / props.total) * 100) : 0,
);
</script>

<template>
  <div v-if="total > 0" class="min-w-28">
    <p class="text-sm whitespace-nowrap">
      <span class="text-highlighted font-medium">{{
        t("admin.stats.readOf", { read, total })
      }}</span>
      <span class="text-muted"> · {{ share }} %</span>
    </p>
    <UProgress
      :model-value="share"
      size="xs"
      class="mt-1"
      :aria-label="t('admin.stats.readOf', { read, total })"
    />
    <p v-if="changed > 0" class="text-muted mt-0.5 text-xs">
      {{ t("admin.stats.changedCount", changed) }}
    </p>
  </div>
  <span v-else class="text-dimmed text-sm">–</span>
</template>

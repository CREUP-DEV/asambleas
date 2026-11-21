<script setup lang="ts">
/**
 * «Página X de N»: the page of the text's PDF being read (ContentView's
 * `page`), for the text's bar (user's decisions of 2026-11-21). Shown
 * also on narrow screens, where the «pág. N» marks are not. `floating`
 * keeps it at the top end of a text that scrolls with the page, where
 * there is no bar of its own.
 */
const props = defineProps<{
  page: number | null;
  total: number;
  floating?: boolean;
}>();

const { t } = useI18n();

const label = computed(() =>
  props.page === null || props.total <= 0
    ? ""
    : t("common.content.pageOf", { page: props.page, total: props.total }),
);
</script>

<template>
  <div
    v-if="label && floating"
    class="pointer-events-none sticky top-2 z-10 -mb-7 flex h-7 justify-end"
  >
    <span
      class="bg-default/90 ring-default text-dimmed pointer-events-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs whitespace-nowrap tabular-nums ring"
      :title="t('common.content.pageOfTitle')"
    >
      <UIcon name="i-lucide-file-text" class="size-3.5 shrink-0" />
      {{ label }}
    </span>
  </div>
  <span
    v-else-if="label"
    class="text-dimmed inline-flex items-center gap-1 text-xs whitespace-nowrap tabular-nums"
    :title="t('common.content.pageOfTitle')"
  >
    <UIcon name="i-lucide-file-text" class="size-3.5 shrink-0" />
    {{ label }}
  </span>
</template>

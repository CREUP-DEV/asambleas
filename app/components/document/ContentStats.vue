<script setup lang="ts">
import type { Block } from "~~/shared/types/content";

/** Word and paragraph count of a draft ("1.234 palabras · 12 párrafos"). */
const props = defineProps<{ blocks: Block[] }>();

const { t, n } = useI18n();

const counts = computed(() => {
  let words = 0;
  let paragraphs = 0;
  for (const block of props.blocks) {
    const blockWords = block.text
      .split(/\s+/)
      .filter((word) => word.length > 0).length;
    words += blockWords;
    if (block.type !== "heading" && blockWords > 0) paragraphs += 1;
  }
  return { words, paragraphs };
});
</script>

<template>
  <p class="text-muted text-xs tabular-nums sm:text-sm">
    {{ t("document.stats.words", { count: n(counts.words) }, counts.words) }}
    <span aria-hidden="true"> · </span>
    {{
      t(
        "document.stats.paragraphs",
        { count: n(counts.paragraphs) },
        counts.paragraphs,
      )
    }}
  </p>
</template>

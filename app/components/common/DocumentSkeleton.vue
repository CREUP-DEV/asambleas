<script setup lang="ts">
/**
 * A document on its way: a heading and a few paragraphs of grey lines, so a
 * box that will hold a text or a PDF never reads as empty or as the
 * previous document while it loads (user's decision of 2026-11-19). Said
 * once to screen readers (`role="status"`); the lines are hidden from them.
 * The lines take the type size of their container, so the same markup
 * serves a page and the projection.
 */
withDefaults(defineProps<{ paragraphs?: number }>(), { paragraphs: 3 });

const { t } = useI18n();

/** Each paragraph's last line is shorter, as in a text. */
const LINES = ["w-full", "w-full", "w-11/12", "w-3/5"] as const;
</script>

<template>
  <div role="status" class="space-y-[1.5em]">
    <span class="sr-only">{{ t("common.loadingDocument") }}</span>
    <USkeleton aria-hidden="true" class="h-[1.4em] w-2/3" />
    <div
      v-for="paragraph in paragraphs"
      :key="paragraph"
      class="space-y-[0.6em]"
      aria-hidden="true"
    >
      <USkeleton
        v-for="width in LINES"
        :key="width + paragraph"
        :class="['h-[0.9em]', width]"
      />
    </div>
  </div>
</template>

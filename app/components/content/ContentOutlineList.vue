<script setup lang="ts">
import type { OutlineEntry } from "./ContentView.vue";

/**
 * The headings of a text, nested by level, as a list of links to them; the
 * section being read (`active`) carries a brand bar and a tint, its text kept
 * neutral. Shared by the margin rail and the floating button.
 */
const props = defineProps<{
  items: OutlineEntry[];
  active?: string | null;
}>();

const emit = defineEmits<{ pick: [blockId: string] }>();

const { t } = useI18n();

/** Levels counted from the highest one present, so the top sits flush. */
const entries = computed(() => {
  const top = Math.min(...props.items.map((item) => item.level));
  return props.items.map((item) => ({ ...item, depth: item.level - top }));
});

const DEPTH_PADDING = ["ps-2", "ps-5", "ps-8", "ps-11"];
</script>

<template>
  <nav :aria-label="t('common.content.outline.label')">
    <ul class="flex flex-col">
      <li v-for="entry in entries" :key="entry.id">
        <button
          type="button"
          class="hover:bg-elevated focus-visible:outline-primary w-full rounded-md border-s-2 py-1.5 pe-2 text-start text-sm focus-visible:outline-2"
          :class="[
            DEPTH_PADDING[Math.min(entry.depth, DEPTH_PADDING.length - 1)],
            entry.depth === 0
              ? 'text-highlighted font-semibold'
              : 'text-default',
            entry.id === active
              ? 'border-primary bg-primary/10'
              : 'border-transparent',
          ]"
          :aria-current="entry.id === active ? 'location' : undefined"
          @click="emit('pick', entry.id)"
        >
          {{ entry.text }}
        </button>
      </li>
    </ul>
  </nav>
</template>

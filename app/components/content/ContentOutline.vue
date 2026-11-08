<script setup lang="ts">
import type { OutlineEntry } from "./ContentView.vue";

/**
 * The index of a text: a button that opens its headings, nested by level,
 * and takes the reader to the one picked. The section being read is marked
 * when it opens (`current`, asked of the view at that moment).
 */
const props = withDefaults(
  defineProps<{
    items: OutlineEntry[];
    /** The id of the heading of the section being read. */
    current?: () => string | null;
    /** The button's look: on its own over the text, it needs a background. */
    variant?: "ghost" | "outline";
  }>(),
  { current: undefined, variant: "ghost" },
);

const emit = defineEmits<{ select: [blockId: string] }>();

const { t } = useI18n();

const open = ref(false);
const active = ref<string | null>(null);

watch(open, (value) => {
  if (value) active.value = props.current?.() ?? null;
});

/** Levels counted from the highest one present, so the top sits flush. */
const entries = computed(() => {
  const top = Math.min(...props.items.map((item) => item.level));
  return props.items.map((item) => ({ ...item, depth: item.level - top }));
});

const DEPTH_PADDING = ["ps-2", "ps-5", "ps-8", "ps-11"];

function pick(id: string): void {
  open.value = false;
  // After the popover has closed and handed the focus back.
  void nextTick(() => emit("select", id));
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ align: 'end' }">
    <UButton
      color="neutral"
      :variant="variant"
      size="sm"
      icon="i-lucide-list-tree"
      :class="variant === 'outline' ? 'bg-default shadow-sm' : undefined"
      :label="t('common.content.outline.button')"
      :aria-label="t('common.content.outline.label')"
    />

    <template #content>
      <nav
        :aria-label="t('common.content.outline.label')"
        class="max-h-[min(32rem,calc(var(--reka-popover-content-available-height,70dvh)-0.5rem))] w-[min(22rem,90vw)] overflow-y-auto p-1.5"
      >
        <ul class="flex flex-col">
          <li v-for="entry in entries" :key="entry.id">
            <button
              type="button"
              class="hover:bg-elevated focus-visible:outline-primary w-full rounded-md py-1.5 pe-2 text-start text-sm focus-visible:outline-2"
              :class="[
                DEPTH_PADDING[Math.min(entry.depth, DEPTH_PADDING.length - 1)],
                entry.depth === 0
                  ? 'text-highlighted font-semibold'
                  : 'text-default',
                entry.id === active ? 'bg-elevated' : '',
              ]"
              :aria-current="entry.id === active ? 'location' : undefined"
              @click="pick(entry.id)"
            >
              {{ entry.text }}
            </button>
          </li>
        </ul>
      </nav>
    </template>
  </UPopover>
</template>

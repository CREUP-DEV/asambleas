<script setup lang="ts">
import type { OutlineEntry } from "./ContentView.vue";

/**
 * The headings of a text, nested by level, as a list of links to them, under
 * a header that says how far the reader is ("Section 5 of 37", and a bar).
 * The section being read (`active`) carries a brand bar and a tint, its text
 * kept neutral, and the list opens scrolled to it. The arrow keys, Home and
 * End move between the headings. Shared by the margin rail and the floating
 * button.
 */
const props = defineProps<{
  items: OutlineEntry[];
  active?: string | null;
}>();

const emit = defineEmits<{ pick: [blockId: string] }>();

const { t } = useI18n();

const list = useTemplateRef<HTMLElement>("list");

/** Levels counted from the highest one present, so the top sits flush. */
const entries = computed(() => {
  const top = Math.min(...props.items.map((item) => item.level));
  return props.items.map((item) => ({ ...item, depth: item.level - top }));
});

const position = computed(() => {
  const index = props.items.findIndex((item) => item.id === props.active);
  return index < 0 ? null : index + 1;
});

const DEPTH_PADDING = ["ps-2", "ps-5", "ps-8", "ps-11"];

function buttons(): HTMLButtonElement[] {
  return Array.from(list.value?.querySelectorAll("button") ?? []);
}

/** Moves the focus to the current heading, or the first one. */
function focusCurrent(): void {
  const all = buttons();
  (
    all.find((button) => button.hasAttribute("aria-current")) ?? all[0]
  )?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  const all = buttons();
  const index = all.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "ArrowDown"
      ? Math.min(index + 1, all.length - 1)
      : event.key === "ArrowUp"
        ? Math.max(index - 1, 0)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? all.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  all[next]?.focus();
}

// Opens on the current heading, scrolling the list only: scrollIntoView
// would move the text behind it as well.
onMounted(() => {
  const current = list.value?.querySelector<HTMLElement>("[aria-current]");
  const box = list.value?.closest<HTMLElement>(".overflow-y-auto");
  if (!current || !box) return;
  const top =
    current.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.scrollTop += top - box.clientHeight / 2;
});

defineExpose({ focusCurrent });
</script>

<template>
  <nav :aria-label="t('common.content.outline.label')">
    <div
      class="bg-default border-default sticky -top-1.5 z-10 -mx-1.5 -mt-1.5 mb-1 rounded-t-lg border-b px-3.5 pt-2.5 pb-2"
    >
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-highlighted text-sm font-semibold">
          {{ t("common.content.outline.button") }}
        </span>
        <span v-if="position" class="text-muted text-xs tabular-nums">
          {{
            t("common.content.outline.progress", {
              current: position,
              total: items.length,
            })
          }}
        </span>
      </div>
      <div
        v-if="position"
        class="bg-elevated mt-2 h-1 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          class="bg-primary h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
          :style="{ width: `${(position / items.length) * 100}%` }"
        />
      </div>
    </div>

    <ul ref="list" class="flex flex-col" @keydown="onKeydown">
      <li v-for="entry in entries" :key="entry.id">
        <button
          type="button"
          class="hover:bg-elevated focus-visible:outline-primary w-full rounded-md border-s-2 py-1.5 pe-2 text-start text-sm transition-colors focus-visible:outline-2"
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

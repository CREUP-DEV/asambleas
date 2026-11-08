<script setup lang="ts">
import type { OutlineEntry } from "./ContentView.vue";

/**
 * The index of a text as marks in its left margin: one per heading, shorter
 * the deeper it sits, the section being read in the brand colour as the text
 * scrolls. Hovering the marks, or reaching them with the keyboard, unfolds
 * the headings beside them (ContentOutlineList); a click on the marks opens
 * or closes them too. It covers no text until it unfolds.
 */
const props = defineProps<{
  items: OutlineEntry[];
  /** The id of the heading of the section being read. */
  current?: () => string | null;
}>();

const emit = defineEmits<{ select: [blockId: string] }>();

const { t } = useI18n();

const root = useTemplateRef<HTMLElement>("root");
const trigger = useTemplateRef<HTMLButtonElement>("trigger");
const open = ref(false);
const active = ref<string | null>(null);

const depths = computed(() => {
  const top = Math.min(...props.items.map((item) => item.level));
  return props.items.map((item) => ({ id: item.id, depth: item.level - top }));
});

const TICK_WIDTHS = ["w-3.5", "w-3", "w-2.5", "w-2"];

// The section being read, followed as any scroll container moves.
let frame = 0;
function track(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    active.value = props.current?.() ?? null;
  });
}
useEventListener(window, "scroll", track, { capture: true, passive: true });
watch(() => props.items, track);
onMounted(track);

// Unfolding: on hover, after a moment so passing over it does nothing, and
// while the focus is inside; folding a moment after both leave.
let timer: ReturnType<typeof setTimeout> | undefined;
function hold(value: boolean, delay: number): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (value) track();
    open.value = value;
  }, delay);
}

function onMouseLeave(): void {
  if (!root.value?.contains(document.activeElement)) hold(false, 250);
  else clearTimeout(timer);
}

function onFocusOut(event: FocusEvent): void {
  if (!root.value?.contains(event.relatedTarget as Node | null)) {
    hold(false, 0);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !open.value) return;
  event.stopPropagation();
  clearTimeout(timer);
  open.value = false;
  trigger.value?.focus();
}

function toggle(): void {
  clearTimeout(timer);
  if (!open.value) track();
  open.value = !open.value;
}

function pick(id: string): void {
  clearTimeout(timer);
  open.value = false;
  emit("select", id);
}

onBeforeUnmount(() => {
  clearTimeout(timer);
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <div
    ref="root"
    class="relative w-fit"
    @mouseenter="hold(true, 120)"
    @mouseleave="onMouseLeave"
    @focusout="onFocusOut"
    @keydown="onKeydown"
  >
    <button
      ref="trigger"
      type="button"
      class="group focus-visible:outline-primary flex flex-col gap-[5px] rounded-sm px-0.5 py-1 focus-visible:outline-2"
      :aria-label="t('common.content.outline.label')"
      :aria-expanded="open"
      @click="toggle"
      @focus="hold(true, 0)"
    >
      <span
        v-for="tick in depths"
        :key="tick.id"
        aria-hidden="true"
        class="block rounded-full transition-colors"
        :class="[
          TICK_WIDTHS[Math.min(tick.depth, TICK_WIDTHS.length - 1)],
          tick.id === active
            ? 'bg-primary h-[3px]'
            : 'bg-(--ui-text-muted) group-hover:bg-(--ui-text-toned) h-0.5',
        ]"
      />
    </button>

    <div
      v-if="open"
      class="bg-default ring-default absolute start-full top-0 z-30 ms-2 max-h-[70dvh] w-[min(20rem,75vw)] overflow-y-auto rounded-md p-1.5 shadow-lg ring"
    >
      <ContentOutlineList :items="items" :active="active" @pick="pick" />
    </div>
  </div>
</template>

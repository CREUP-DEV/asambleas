<script setup lang="ts">
import type { OutlineEntry } from "./ContentView.vue";

/**
 * The index of a text as marks in its left margin: one per heading, shorter
 * the deeper it sits, showing the reading as the text scrolls: the sections
 * read in a soft burgundy, the one being read in burgundy and longest, the
 * rest grey. Hovering the marks (which stretch), or reaching them with the
 * keyboard, unfolds the headings beside them (ContentOutlineList); a click
 * opens or closes them too, and the down arrow moves into them. It covers no
 * text until it unfolds; motion stays off when the system asks for less.
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
const listView = useTemplateRef<{ focusCurrent: () => void }>("listView");
const open = ref(false);
const active = ref<string | null>(null);

const depths = computed(() => {
  const top = Math.min(...props.items.map((item) => item.level));
  return props.items.map((item) => ({ id: item.id, depth: item.level - top }));
});

const activeIndex = computed(() =>
  props.items.findIndex((item) => item.id === active.value),
);

const TICK_WIDTHS = ["w-3.5", "w-3", "w-2.5", "w-2"];

/** A mark's look: read, being read (longest) or still ahead. */
function tickClass(index: number, depth: number): string[] {
  if (index === activeIndex.value) return ["bg-primary h-[3px] w-4"];
  const width = TICK_WIDTHS[Math.min(depth, TICK_WIDTHS.length - 1)]!;
  return index < activeIndex.value
    ? [width, "bg-primary/40 h-0.5"]
    : [width, "bg-(--ui-text-muted) group-hover:bg-(--ui-text-toned) h-0.5"];
}

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
  if (event.key === "ArrowDown" && event.target === trigger.value) {
    event.preventDefault();
    clearTimeout(timer);
    if (!open.value) track();
    open.value = true;
    void nextTick(() => listView.value?.focusCurrent());
    return;
  }
  if (event.key !== "Escape" || !open.value) return;
  event.stopPropagation();
  clearTimeout(timer);
  open.value = false;
  // Back on the marks, folded: the focus coming back must not unfold them.
  refocusing = true;
  trigger.value?.focus();
  refocusing = false;
}

/** Reaching the marks with the keyboard unfolds them. */
let refocusing = false;
function onTriggerFocus(): void {
  if (!refocusing) hold(true, 0);
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
      @focus="onTriggerFocus"
    >
      <span
        v-for="(tick, index) in depths"
        :key="tick.id"
        aria-hidden="true"
        class="block origin-left rounded-full transition-[width,height,background-color,transform] duration-300 ease-out group-hover:scale-x-125 motion-reduce:transition-none"
        :class="tickClass(index, tick.depth)"
      />
    </button>

    <Transition
      enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
      enter-from-class="-translate-x-1 opacity-0"
      leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
      leave-to-class="-translate-x-1 opacity-0"
    >
      <div
        v-if="open"
        class="bg-default ring-default absolute start-full top-0 z-30 ms-3 max-h-[70dvh] w-[min(20rem,75vw)] overflow-y-auto rounded-lg p-1.5 shadow-xl ring"
      >
        <ContentOutlineList
          ref="listView"
          :items="items"
          :active="active"
          @pick="pick"
        />
      </div>
    </Transition>
  </div>
</template>

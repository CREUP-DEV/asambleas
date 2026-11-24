<script setup lang="ts">
import {
  pageMarks,
  pageRange,
  type PageMark,
} from "~~/shared/utils/content/pageMarks";
import { scrollParent } from "~/utils/outline";
import type { ContentPages } from "./ContentView.vue";

/**
 * «pág. N» beside a text that is not ContentView's (the editor's, while
 * correcting the form of an approved text; user's decision of 2026-11-24):
 * where each page of its PDF starts, over the blocks `root` shows
 * (`data-block-id`), and the bubble «3 de 37» beside the scrollbar while it
 * scrolls, as ContentView shows them for the readers. It lies over its
 * parent, which must be positioned and leave room at its end edge
 * (`cx-has-pages`). `revision` changes whenever the blocks may have moved
 * or changed; blocks added since the PDF have no page, and a start whose
 * block is gone moves to the next one (pageMarks).
 */
const props = defineProps<{
  pages: ContentPages | null | undefined;
  root: HTMLElement | null | undefined;
  revision?: number;
}>();

const emit = defineEmits<{ page: [page: number | null] }>();

const { t } = useI18n();
const gutterEl = useTemplateRef<HTMLElement>("gutter");

/** The blocks shown, in order. */
const ids = shallowRef<string[]>([]);
const entries = computed<[string, PageMark][]>(() =>
  props.pages
    ? Object.entries(
        pageMarks(ids.value, props.pages.starts, props.pages.order),
      )
    : [],
);
const positions = shallowRef<Record<string, number>>({});

function readIds(root: HTMLElement): void {
  const next: string[] = [];
  const seen = new Set<string>();
  root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
    const id = element.dataset.blockId ?? "";
    if (id && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  });
  const previous = ids.value;
  if (
    previous.length !== next.length ||
    previous.some((id, index) => id !== next[index])
  ) {
    ids.value = next;
  }
}

/** A block's element, or its table row's: where its page mark goes. */
function anchorOf(root: HTMLElement, id: string): HTMLElement | null {
  const element = root.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(id)}"]`,
  );
  return element ? (element.closest<HTMLElement>("tr") ?? element) : null;
}

let layoutFrame = 0;
function measure(): void {
  layoutFrame = 0;
  const root = props.root;
  const gutter = gutterEl.value;
  if (!root || !gutter || !props.pages) {
    if (Object.keys(positions.value).length > 0) positions.value = {};
    return;
  }
  readIds(root);
  const top = gutter.getBoundingClientRect().top;
  const next: Record<string, number> = {};
  for (const [id] of entries.value) {
    const anchor = anchorOf(root, id);
    if (anchor) next[id] = Math.round(anchor.getBoundingClientRect().top - top);
  }
  positions.value = next;
  updatePage();
}

function scheduleLayout(): void {
  if (!import.meta.client || layoutFrame) return;
  layoutFrame = requestAnimationFrame(measure);
}

function markLabel(mark: PageMark): string {
  return t(
    "common.content.pageMark",
    { pages: pageRange(mark.pages) },
    mark.pages.length,
  );
}

function markTitle(mark: PageMark): string {
  return t(
    "common.content.pageMarkTitle",
    { pages: pageRange(mark.pages) },
    mark.pages.length,
  );
}

// The page being read: the last mark above the reading line, as ContentView
// reads it; the bubble follows the scrollbar's thumb while the text scrolls.

const currentPage = ref<number | null>(null);
let pageFrame = 0;
let bubbleDue = false;
const bubble = reactive({ visible: false, top: 0, right: 0 });
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;

function pageAtReadingLine(): number | null {
  const root = props.root;
  const list = entries.value;
  if (!root || list.length === 0) return null;
  const parent = scrollParent(root);
  const box = parent
    ? parent.getBoundingClientRect()
    : { top: 0, height: window.innerHeight };
  const line = box.top + Math.max(96, box.height / 4);
  let current: number | null = null;
  for (const [id, mark] of list) {
    const anchor = anchorOf(root, id);
    if (!anchor) continue;
    const rect = anchor.getBoundingClientRect();
    if (rect.top > line) break;
    const share = rect.height > 0 ? (line - rect.top) / rect.height : 0;
    const index = Math.min(
      mark.pages.length - 1,
      Math.max(0, Math.floor(share * mark.pages.length)),
    );
    current = mark.pages[index]!;
  }
  return current ?? list[0]![1].pages[0]!;
}

function placeBubble(): void {
  const root = props.root;
  if (!root || !props.pages?.total) return;
  const parent = scrollParent(root);
  const scroller = parent ?? document.scrollingElement;
  if (!scroller) return;
  const range = scroller.scrollHeight - scroller.clientHeight;
  if (range <= 0) return;
  const box = parent
    ? parent.getBoundingClientRect()
    : { top: 0, right: window.innerWidth, height: window.innerHeight };
  const travel = Math.max(0, box.height - 56);
  bubble.top = box.top + 12 + (scroller.scrollTop / range) * travel;
  bubble.right = Math.max(0, window.innerWidth - box.right) + 20;
  bubble.visible = true;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.visible = false;
  }, 1200);
}

function updatePage(): void {
  pageFrame = 0;
  if (bubbleDue) {
    bubbleDue = false;
    placeBubble();
  }
  const page = pageAtReadingLine();
  if (page === currentPage.value) return;
  currentPage.value = page;
  emit("page", page);
}

function onScroll(event: Event): void {
  const target = event.target;
  const root = props.root;
  if (
    root &&
    (target === document ||
      (target instanceof Element && target.contains(root)))
  ) {
    bubbleDue = true;
  }
  if (!pageFrame && entries.value.length > 0) {
    pageFrame = requestAnimationFrame(updatePage);
  }
}

useResizeObserver(() => props.root ?? null, scheduleLayout);
watch(
  [() => props.root, () => props.pages, () => props.revision],
  scheduleLayout,
  { flush: "post", immediate: true },
);

onMounted(() => {
  void document.fonts?.ready.then(scheduleLayout);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
});

onBeforeUnmount(() => {
  if (layoutFrame) cancelAnimationFrame(layoutFrame);
  if (pageFrame) cancelAnimationFrame(pageFrame);
  clearTimeout(bubbleTimer);
  window.removeEventListener("scroll", onScroll, { capture: true });
});

defineExpose({ currentPage });
</script>

<template>
  <div ref="gutter" class="cx-pages" aria-hidden="true">
    <template v-for="[id, mark] in entries" :key="id">
      <span
        v-if="positions[id] !== undefined"
        class="cx-page-mark"
        :class="{ 'cx-page-mark--inside': mark.inside }"
        :style="{ top: `${positions[id]}px` }"
      >
        <span class="cx-page-mark-label" :title="markTitle(mark)">{{
          markLabel(mark)
        }}</span>
      </span>
    </template>
    <ClientOnly>
      <Teleport to="body">
        <Transition
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
          enter-active-class="motion-safe:transition-opacity motion-safe:duration-150"
          leave-active-class="motion-safe:transition-opacity motion-safe:duration-300"
        >
          <div
            v-if="bubble.visible && currentPage !== null && pages?.total"
            class="bg-inverted text-inverted pointer-events-none fixed z-50 rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap shadow-md"
            :style="{ top: `${bubble.top}px`, right: `${bubble.right}px` }"
            aria-hidden="true"
          >
            {{
              t("common.content.pageBubble", {
                page: currentPage,
                total: pages.total,
              })
            }}
          </div>
        </Transition>
      </Teleport>
    </ClientOnly>
  </div>
</template>

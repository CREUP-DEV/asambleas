<script setup lang="ts">
import type { Block, ConsolidatedBlock } from "~~/shared/types/content";
import { renderAnnotated, renderBlocks } from "~~/shared/utils/content/render";
import {
  pageMarks,
  pageRange,
  type PageMark,
} from "~~/shared/utils/content/pageMarks";
import type { PageMapStart } from "~~/shared/types/api";
import { headingAtReadingLine, scrollParent } from "~/utils/outline";

export type ContentViewMode = "plain" | "diff" | "provenance" | "clean";

/**
 * The pages of the text's PDF to show beside it (user's decisions of
 * 2026-11-21; shared/utils/content/pageMarks.ts): where each page starts,
 * and the blocks of the version they are for, in order.
 */
export interface ContentPages {
  starts: PageMapStart[];
  order?: string[];
  /** Printed pages, for the bubble beside the scrollbar. */
  total?: number;
}

/** A heading of the rendered text, for its index (ContentOutline). */
export interface OutlineEntry {
  id: string;
  /** 1 for the top level, as blocks number it. */
  level: number;
  text: string;
}

/**
 * Gutter marker of one block: amendments touching it and whether they
 * overlap. It shows as a thin line down the block's side; how many there
 * are is its name (and a small count while the pointer or the focus is on
 * it), so the text reads undisturbed.
 */
export interface BlockMarker {
  count: number;
  overlap: boolean;
}

/**
 * Read-only structured content. The HTML comes only from
 * shared/utils/content/render.ts, which escapes every text and filters links,
 * so it is safe for v-html by construction.
 *
 * - `plain` renders `blocks`; `diff`, `provenance` and `clean` render
 *   `annotated` (falls back to the other input when one is missing).
 * - Clicks are delegated: `block-click` for the nearest `data-block-id`,
 *   `amendment-click` for the nearest `data-amendment-id` (an inserted or
 *   deleted block carries both, so both fire). Links never trigger them.
 * - With `interactive`, amended fragments are buttons (focusable, Enter/Space
 *   act as a click). Blocks are focusable only in `plain` mode, the only one
 *   where picking a block does something, and then describe (for screen
 *   readers) that Enter picks them and Shift with Enter adds to the choice.
 * - `headings: false` renders headings as styled paragraphs, for excerpts
 *   whose headings must not join the page outline.
 */
const props = withDefaults(
  defineProps<{
    blocks?: Block[];
    annotated?: ConsolidatedBlock[];
    mode?: ContentViewMode;
    /** Short amendment label for provenance references ("12", "T1"). */
    label?: (amendmentId: string) => string;
    /** Amendment whose fragments are highlighted. */
    focus?: string | null;
    /** Highlighted block ids. */
    selected?: string[];
    /** Gutter markers per block id. */
    markers?: Record<string, BlockMarker>;
    interactive?: boolean;
    /** Gutter markers as buttons also when the text is not interactive. */
    markerButtons?: boolean;
    /** Headings as real heading elements; false for excerpts. */
    headings?: boolean;
    /**
     * Passages approved pending conciliation (user's decisions of
     * 2026-11-21): their blocks are marked and the first one opens with
     * `label` («Pendiente de conciliar E3 y E5»).
     */
    pending?: { blockIds: string[]; label: string }[];
    /**
     * «pág. N» at the side opposite the gutter, where each page of the PDF
     * starts (hidden on narrow screens); the page being read comes out as
     * `page`, for the text's «Página X de N».
     */
    pages?: ContentPages | null;
  }>(),
  {
    blocks: undefined,
    annotated: undefined,
    mode: "plain",
    label: undefined,
    focus: null,
    selected: () => [],
    markers: undefined,
    interactive: false,
    markerButtons: false,
    headings: true,
    pending: () => [],
    pages: null,
  },
);

const emit = defineEmits<{
  "block-click": [blockId: string, event: MouseEvent | KeyboardEvent];
  "amendment-click": [amendmentId: string];
  /** A gutter marker was activated (`interactive` or `markerButtons`). */
  "marker-click": [blockId: string, event: MouseEvent];
  /** The PDF page being read, with `pages` (null without). */
  page: [page: number | null];
}>();

const { t, locale } = useI18n();

/** Distinct provenance underline colours (see `.cx-prov-N` in main.css). */
const PROVENANCE_COLORS = 6;
/** Says how to pick a focusable block, for screen readers (aria-describedby). */
const blockHintId = useId();

const containerEl = useTemplateRef<HTMLElement>("containerEl");
const contentEl = useTemplateRef<HTMLElement>("contentEl");

const html = computed(() => {
  const headings = props.headings;
  if (props.annotated && props.mode !== "plain") {
    return renderAnnotated(props.annotated, {
      mode: props.mode,
      label: props.label,
      focus: props.focus,
      headings,
      omitted: t("common.content.omitted"),
      diffLabels:
        props.mode === "diff"
          ? {
              inserted: t("common.content.inserted"),
              removed: t("common.content.removed"),
              formatted: t("common.content.formatted"),
              format: (change) =>
                t(`common.content.format.${change.code}`, {
                  value: change.value ?? "",
                }),
              quote: (text) => t("common.content.formatQuote", { text }),
              space: t("common.content.formatSpace"),
            }
          : undefined,
    });
  }
  if (props.blocks) return renderBlocks(props.blocks, { headings });
  if (props.annotated)
    return renderAnnotated(props.annotated, {
      mode: "clean",
      headings,
      omitted: t("common.content.omitted"),
    });
  return "";
});

/** Blocks can be picked (and focused) only in the plain, interactive view. */
const selectableBlocks = computed(
  () => props.interactive && props.mode === "plain",
);

const markerEntries = computed(() =>
  Object.entries(props.markers ?? {}).filter(([, marker]) => marker.count > 0),
);
const hasMarkers = computed(() => markerEntries.value.length > 0);

/** The blocks the view shows, in order (read after each render). */
const viewIds = shallowRef<string[]>([]);
/** «pág. N» marks, in the order of the pages. */
const pageMarkEntries = computed<[string, PageMark][]>(() =>
  props.pages
    ? Object.entries(
        pageMarks(viewIds.value, props.pages.starts, props.pages.order),
      )
    : [],
);
const hasPages = computed(() => pageMarkEntries.value.length > 0);

function pageMarkLabel(mark: PageMark): string {
  return t(
    "common.content.pageMark",
    { pages: pageRange(mark.pages) },
    mark.pages.length,
  );
}

function pageMarkTitle(mark: PageMark): string {
  return t(
    "common.content.pageMarkTitle",
    { pages: pageRange(mark.pages) },
    mark.pages.length,
  );
}

function readViewIds(root: HTMLElement): void {
  const ids: string[] = [];
  const seen = new Set<string>();
  root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
    const id = element.dataset.blockId ?? "";
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  });
  const previous = viewIds.value;
  if (
    previous.length !== ids.length ||
    previous.some((id, index) => id !== ids[index])
  ) {
    viewIds.value = ids;
  }
}

function markerLabel(marker: BlockMarker): string {
  const count = t(
    "common.content.markerCount",
    { count: marker.count },
    marker.count,
  );
  return marker.overlap
    ? `${count}. ${t("common.content.markerOverlap")}`
    : count;
}

// DOM decoration ----------------------------------------------------------------
// v-html replaces the nodes whenever the HTML changes, so focusability, the
// selection highlight and provenance colours are applied after each render.

function decorate(): void {
  const root = contentEl.value;
  if (!root) {
    if (outline.value.length > 0) outline.value = [];
    return;
  }
  const selected = new Set(props.selected);
  const pending = new Set(props.pending.flatMap((passage) => passage.blockIds));
  const pendingLabels = new Map<string, string>();
  for (const passage of props.pending) {
    const first = passage.blockIds[0];
    if (first && !pendingLabels.has(first)) {
      pendingLabels.set(first, passage.label);
    }
  }

  root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
    const id = element.dataset.blockId ?? "";
    if (selectableBlocks.value) {
      element.tabIndex = 0;
      element.setAttribute("aria-describedby", blockHintId);
    } else {
      element.removeAttribute("tabindex");
      element.removeAttribute("aria-describedby");
    }
    // A passage pending conciliation: marked, its first block labelled.
    element.classList.toggle("cx-pending", pending.has(id));
    const pendingLabel = pendingLabels.get(id);
    element.classList.toggle("cx-pending-start", Boolean(pendingLabel));
    if (pendingLabel) element.dataset.pendingLabel = pendingLabel;
    else delete element.dataset.pendingLabel;
    const isSelected = selected.has(id);
    element.classList.toggle("cx-selected", isSelected);
    if (isSelected) element.setAttribute("aria-current", "true");
    else element.removeAttribute("aria-current");
  });

  root
    .querySelectorAll<HTMLElement>("[data-amendment-id]:not([data-block-id])")
    .forEach((element) => {
      const id = element.dataset.amendmentId ?? "";
      const label =
        props.interactive &&
        props.label &&
        element.classList.contains("cx-prov")
          ? props.label(id)
          : "";
      if (props.interactive) {
        element.tabIndex = 0;
        element.setAttribute("role", "button");
      } else {
        element.removeAttribute("tabindex");
        element.removeAttribute("role");
      }
      // The visible label sits in an aria-hidden <sup>: say it in the name.
      if (label) {
        element.setAttribute(
          "aria-label",
          t("common.content.fragmentFrom", {
            text: element.textContent?.trim() ?? "",
            label,
          }),
        );
      } else {
        element.removeAttribute("aria-label");
      }
    });

  readOutline(root);
  if (props.pages) readViewIds(root);

  const order = new Map<string, number>();
  root.querySelectorAll<HTMLElement>(".cx-prov").forEach((element) => {
    const id = element.dataset.amendmentId ?? "";
    if (!order.has(id)) order.set(id, order.size);
    const colorClass = `cx-prov-${order.get(id)! % PROVENANCE_COLORS}`;
    element.classList.add(colorClass);
    const reference = element.nextElementSibling;
    if (reference?.classList.contains("cx-ref")) {
      reference.classList.add(colorClass);
    }
  });
}

// Outline -------------------------------------------------------------------------
// The headings as shown (in a diff, the text they end up with), read from the
// rendered HTML so every mode lists what it displays. Headings inside table
// cells are part of the table, not the document's structure.

const outline = shallowRef<OutlineEntry[]>([]);

function readOutline(root: HTMLElement): void {
  const entries: OutlineEntry[] = [];
  root
    .querySelectorAll<HTMLElement>(
      "h2[data-block-id], h3[data-block-id], h4[data-block-id], h5[data-block-id]",
    )
    .forEach((element) => {
      if (element.closest("table")) return;
      const copy = element.cloneNode(true) as HTMLElement;
      // A format label says what changes; it is not part of the heading.
      const extras = "del, .sr-only, .cx-ref, .cx-fmt-label";
      copy.querySelectorAll(extras).forEach((node) => {
        node.remove();
      });
      const text = (copy.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text) return;
      entries.push({
        id: element.dataset.blockId ?? "",
        level: Number(element.tagName.slice(1)) - 1,
        text,
      });
    });
  const previous = outline.value;
  const same =
    previous.length === entries.length &&
    previous.every(
      (entry, i) =>
        entry.id === entries[i]!.id &&
        entry.level === entries[i]!.level &&
        entry.text === entries[i]!.text,
    );
  if (!same) outline.value = entries;
}

/** The heading of the section being read (headingAtReadingLine). */
function currentHeading(): string | null {
  const root = contentEl.value;
  if (!root) return null;
  return headingAtReadingLine(
    root,
    outline.value.map((entry) => entry.id),
  );
}

// Gutter layout ---------------------------------------------------------------------

const positions = shallowRef<Record<string, { top: number; height: number }>>(
  {},
);
let layoutFrame = 0;

/** Where each «pág. N» goes: the top of its block, or of its table's row. */
const pagePositions = shallowRef<Record<string, number>>({});

function measurePages(root: HTMLElement, top: number): void {
  const next: Record<string, number> = {};
  for (const [id] of pageMarkEntries.value) {
    const element = root.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(id)}"]`,
    );
    if (!element) continue;
    const anchor = element.closest<HTMLElement>("tr") ?? element;
    next[id] = Math.round(anchor.getBoundingClientRect().top - top);
  }
  pagePositions.value = next;
}

function measure(): void {
  layoutFrame = 0;
  const root = contentEl.value;
  const container = containerEl.value;
  if (root && container && hasPages.value) {
    measurePages(root, container.getBoundingClientRect().top);
  } else if (Object.keys(pagePositions.value).length > 0) {
    pagePositions.value = {};
  }
  updatePage();
  if (!root || !container || !hasMarkers.value) {
    positions.value = {};
    return;
  }
  const top = container.getBoundingClientRect().top;
  const next: Record<string, { top: number; height: number }> = {};
  for (const [id] of markerEntries.value) {
    const element = root.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(id)}"]`,
    );
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    next[id] = {
      top: Math.round(rect.top - top),
      height: Math.round(rect.height),
    };
  }
  positions.value = next;
}

function scheduleLayout(): void {
  if (!import.meta.client || layoutFrame) return;
  layoutFrame = requestAnimationFrame(measure);
}

// The page being read ---------------------------------------------------------------
// The page of the last «pág. N» above the reading line (as the outline reads
// the section); within a block several pages run on to, by how far down it
// the line falls.

const currentPage = ref<number | null>(null);
let pageFrame = 0;

function pageAtReadingLine(): number | null {
  const root = contentEl.value;
  const entries = pageMarkEntries.value;
  if (!root || entries.length === 0) return null;
  const parent = scrollParent(root);
  const box = parent
    ? parent.getBoundingClientRect()
    : { top: 0, height: window.innerHeight };
  const line = box.top + Math.max(96, box.height / 4);
  let current: number | null = null;
  for (const [id, mark] of entries) {
    const element = root.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(id)}"]`,
    );
    if (!element) continue;
    const rect = (element.closest("tr") ?? element).getBoundingClientRect();
    if (rect.top > line) break;
    const share = rect.height > 0 ? (line - rect.top) / rect.height : 0;
    const index = Math.min(
      mark.pages.length - 1,
      Math.max(0, Math.floor(share * mark.pages.length)),
    );
    current = mark.pages[index]!;
  }
  return current ?? entries[0]![1].pages[0]!;
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

function schedulePage(): void {
  if (pageFrame || !hasPages.value) return;
  pageFrame = requestAnimationFrame(updatePage);
}

// The page beside the scrollbar, as Google Docs shows it (user's decision
// of 2026-11-21): while the text scrolls, a bubble «3 de 37» follows the
// scrollbar's thumb at the end edge of what scrolls, and fades a moment
// after it stops. Visual only: the text's bar says the page to screen
// readers (ContentPageIndicator).

const bubble = reactive({ visible: false, top: 0, right: 0 });
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
let bubbleDue = false;

function placeBubble(): void {
  const root = contentEl.value;
  if (!root || !props.pages?.total) return;
  const parent = scrollParent(root);
  const scroller = parent ?? document.scrollingElement;
  if (!scroller) return;
  const range = scroller.scrollHeight - scroller.clientHeight;
  if (range <= 0) return;
  const box = parent
    ? parent.getBoundingClientRect()
    : { top: 0, right: window.innerWidth, height: window.innerHeight };
  // The thumb's share of the track, kept clear of both ends.
  const travel = Math.max(0, box.height - 56);
  bubble.top = box.top + 12 + (scroller.scrollTop / range) * travel;
  bubble.right = Math.max(0, window.innerWidth - box.right) + 20;
  bubble.visible = true;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.visible = false;
  }, 1200);
}

/** A scroll that moves this text: its own pane's, or the page's. */
function onScroll(event: Event): void {
  const target = event.target;
  const root = contentEl.value;
  if (
    root &&
    (target === document ||
      (target instanceof Element && target.contains(root)))
  ) {
    bubbleDue = true;
  }
  schedulePage();
}

useResizeObserver(contentEl, scheduleLayout);

watch(
  [
    html,
    () => props.selected,
    () => props.pending,
    () => props.interactive,
    selectableBlocks,
    locale,
  ],
  () => decorate(),
  { flush: "post" },
);
watch([html, markerEntries, pageMarkEntries], scheduleLayout, {
  flush: "post",
});
// The pages arrive after the text: its blocks are read then.
watch(
  () => props.pages,
  () => {
    if (props.pages && contentEl.value) readViewIds(contentEl.value);
  },
  { flush: "post" },
);

onMounted(() => {
  decorate();
  scheduleLayout();
  // Web fonts change line heights once they load.
  void document.fonts?.ready.then(scheduleLayout);
  // Any scroll that may move the text (the page's or a pane's).
  window.addEventListener("scroll", onScroll, {
    capture: true,
    passive: true,
  });
});

onBeforeUnmount(() => {
  if (layoutFrame) cancelAnimationFrame(layoutFrame);
  if (pageFrame) cancelAnimationFrame(pageFrame);
  window.removeEventListener("scroll", onScroll, { capture: true });
  clearTimeout(bubbleTimer);
});

// Events --------------------------------------------------------------------------

function closestWithin(target: EventTarget | null, selector: string) {
  const root = contentEl.value;
  if (!root || !(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(selector);
  return element && root.contains(element) ? element : null;
}

/** True while the user has text selected inside this view (drag to select). */
function hasTextSelection(): boolean {
  const root = contentEl.value;
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed) return false;
  return selection.rangeCount > 0 && root.contains(selection.anchorNode);
}

function onClick(event: MouseEvent): void {
  if (closestWithin(event.target, "a[href]")) return;
  // Selecting a passage is not a click: consumers read getSelectedBlockIds().
  if (hasTextSelection()) return;
  const fragment = closestWithin(event.target, "[data-amendment-id]");
  if (fragment?.dataset.amendmentId) {
    emit("amendment-click", fragment.dataset.amendmentId);
  }
  const block = closestWithin(event.target, "[data-block-id]");
  if (block?.dataset.blockId) emit("block-click", block.dataset.blockId, event);
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.interactive) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target === contentEl.value) return;
  const { amendmentId, blockId } = target.dataset;
  if (!amendmentId && !blockId) return;
  event.preventDefault();
  if (amendmentId) emit("amendment-click", amendmentId);
  if (blockId) emit("block-click", blockId, event);
}

function onMarkerClick(blockId: string, event: MouseEvent): void {
  emit("marker-click", blockId, event);
}

// Exposed helpers ---------------------------------------------------------------

/** Ids of the blocks that intersect the current text selection, in order. */
function getSelectedBlockIds(): string[] {
  const root = contentEl.value;
  const selection = import.meta.client ? window.getSelection() : null;
  if (!root || !selection || selection.isCollapsed) return [];
  const ranges = Array.from({ length: selection.rangeCount }, (_, i) =>
    selection.getRangeAt(i),
  );
  const ids = new Set<string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data) continue;
    const touched = ranges.some((range) => {
      if (!range.intersectsNode(text)) return false;
      // A range that merely starts at the end of this node or ends at its
      // start selects none of its characters.
      if (range.startContainer === text && range.startOffset >= text.length) {
        return false;
      }
      if (range.endContainer === text && range.endOffset === 0) return false;
      return true;
    });
    if (!touched) continue;
    const block = text.parentElement?.closest<HTMLElement>("[data-block-id]");
    if (block?.dataset.blockId && root.contains(block)) {
      ids.add(block.dataset.blockId);
    }
  }
  // Images hold no text: one counts when the selection runs over it. The
  // blocks come back in the order of the text.
  const ordered: string[] = [];
  root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
    const id = element.dataset.blockId ?? "";
    const picked =
      ids.has(id) ||
      (element.matches("figure.cx-figure") &&
        ranges.some((range) => range.intersectsNode(element)));
    if (picked && !ordered.includes(id)) ordered.push(id);
  });
  return ordered;
}

/**
 * Scrolls a block into view: centred, or to the top for a heading picked in
 * the index (`align: "start"`), which also takes the focus there so the
 * keyboard and screen readers carry on from it (`focus` asks for the same
 * on a centred block). Otherwise it is focused when the view is interactive.
 */
function scrollToBlock(
  blockId: string,
  options: { align?: "center" | "start"; focus?: boolean } = {},
): void {
  const element = contentEl.value?.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(blockId)}"]`,
  );
  if (!element) return;
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const start = options.align === "start";
  const takesFocus = start || options.focus === true;
  element.scrollIntoView({
    block: start ? "start" : "center",
    behavior: reduceMotion ? "auto" : "smooth",
  });
  if (takesFocus && !selectableBlocks.value) {
    element.tabIndex = -1;
    element.addEventListener(
      "blur",
      () => {
        if (!selectableBlocks.value) element.removeAttribute("tabindex");
      },
      { once: true },
    );
  }
  if (takesFocus || selectableBlocks.value) {
    element.focus({ preventScroll: true });
  }
}

defineExpose({
  getSelectedBlockIds,
  scrollToBlock,
  currentHeading,
  outline,
  currentPage,
  root: contentEl,
});
</script>

<template>
  <div
    ref="containerEl"
    class="cx-view relative min-w-0"
    :class="{
      'cx-has-gutter': hasMarkers,
      'cx-has-pages': hasPages,
      'cx-interactive': interactive,
      'cx-selectable': selectableBlocks,
    }"
  >
    <!-- The PDF's pages: what the bar's «Página X de N» says, for the eye. -->
    <div v-if="hasPages && html" class="cx-pages" aria-hidden="true">
      <template v-for="[id, mark] in pageMarkEntries" :key="id">
        <span
          v-if="pagePositions[id] !== undefined"
          class="cx-page-mark"
          :class="{ 'cx-page-mark--inside': mark.inside }"
          :style="{ top: `${pagePositions[id]}px` }"
        >
          <span class="cx-page-mark-label" :title="pageMarkTitle(mark)">{{
            pageMarkLabel(mark)
          }}</span>
        </span>
      </template>
    </div>
    <div v-if="hasMarkers && html" class="cx-gutter">
      <template v-for="[id, marker] in markerEntries" :key="id">
        <template v-if="positions[id] !== undefined">
          <button
            v-if="interactive || markerButtons"
            type="button"
            class="cx-marker"
            :class="{ 'cx-marker--overlap': marker.overlap }"
            :style="{
              top: `${positions[id].top}px`,
              height: `${positions[id].height}px`,
            }"
            :aria-label="markerLabel(marker)"
            :title="markerLabel(marker)"
            :data-marker-block="id"
            @click="onMarkerClick(id, $event)"
          >
            <span class="cx-marker-count" aria-hidden="true">{{
              marker.count
            }}</span>
          </button>
          <span
            v-else
            role="img"
            class="cx-marker"
            :class="{ 'cx-marker--overlap': marker.overlap }"
            :style="{
              top: `${positions[id].top}px`,
              height: `${positions[id].height}px`,
            }"
            :aria-label="markerLabel(marker)"
            :title="markerLabel(marker)"
          >
            <span class="cx-marker-count" aria-hidden="true">{{
              marker.count
            }}</span>
          </span>
        </template>
      </template>
    </div>

    <span v-if="selectableBlocks" :id="blockHintId" class="sr-only">{{
      t("common.content.blockHint")
    }}</span>
    <!-- eslint-disable vue/no-v-html -- render.ts escapes all text and filters links -->
    <div
      v-if="html"
      ref="contentEl"
      class="rich-text cx-content"
      @click="onClick"
      @keydown="onKeydown"
      v-html="html"
    />
    <slot v-else name="empty">
      <!-- eslint-enable vue/no-v-html -->
      <p class="text-muted text-sm">{{ t("common.content.empty") }}</p>
    </slot>
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
            data-testid="page-bubble"
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

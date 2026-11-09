<script setup lang="ts">
import type { Block, ConsolidatedBlock } from "~~/shared/types/content";
import { renderAnnotated, renderBlocks } from "~~/shared/utils/content/render";
import { headingAtReadingLine } from "~/utils/outline";

export type ContentViewMode = "plain" | "diff" | "provenance" | "clean";

/** A heading of the rendered text, for its index (ContentOutline). */
export interface OutlineEntry {
  id: string;
  /** 1 for the top level, as blocks number it. */
  level: number;
  text: string;
}

/** Gutter marker of one block: amendments touching it and whether they overlap. */
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
 *   where picking a block does something.
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
    /** Headings as real heading elements; false for excerpts. */
    headings?: boolean;
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
    headings: true,
  },
);

const emit = defineEmits<{
  "block-click": [blockId: string, event: MouseEvent | KeyboardEvent];
  "amendment-click": [amendmentId: string];
  /** A gutter marker was activated (interactive views only). */
  "marker-click": [blockId: string, event: MouseEvent];
}>();

const { t, locale } = useI18n();

/** Distinct provenance underline colours (see `.cx-prov-N` in main.css). */
const PROVENANCE_COLORS = 6;
/** Height of a gutter marker in px (`.cx-marker`). */
const MARKER_HEIGHT = 22;

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
      diffLabels:
        props.mode === "diff"
          ? {
              inserted: t("common.content.inserted"),
              removed: t("common.content.removed"),
            }
          : undefined,
    });
  }
  if (props.blocks) return renderBlocks(props.blocks, { headings });
  if (props.annotated)
    return renderAnnotated(props.annotated, { mode: "clean", headings });
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

  root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
    const id = element.dataset.blockId ?? "";
    if (selectableBlocks.value) element.tabIndex = 0;
    else element.removeAttribute("tabindex");
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
      copy.querySelectorAll("del, .sr-only, .cx-ref").forEach((node) => {
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

const positions = shallowRef<Record<string, number>>({});
let layoutFrame = 0;

function measure(): void {
  layoutFrame = 0;
  const root = contentEl.value;
  const container = containerEl.value;
  if (!root || !container || !hasMarkers.value) {
    positions.value = {};
    return;
  }
  const top = container.getBoundingClientRect().top;
  const next: Record<string, number> = {};
  for (const [id] of markerEntries.value) {
    const element = root.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(id)}"]`,
    );
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    const lineHeight =
      Number.parseFloat(getComputedStyle(element).lineHeight) || 24;
    const firstLine = Math.min(rect.height, lineHeight);
    next[id] = Math.round(
      rect.top - top + Math.max(0, (firstLine - MARKER_HEIGHT) / 2),
    );
  }
  positions.value = next;
}

function scheduleLayout(): void {
  if (!import.meta.client || layoutFrame) return;
  layoutFrame = requestAnimationFrame(measure);
}

useResizeObserver(contentEl, scheduleLayout);

watch(
  [
    html,
    () => props.selected,
    () => props.interactive,
    selectableBlocks,
    locale,
  ],
  () => decorate(),
  { flush: "post" },
);
watch([html, markerEntries], scheduleLayout, { flush: "post" });

onMounted(() => {
  decorate();
  scheduleLayout();
  // Web fonts change line heights once they load.
  void document.fonts?.ready.then(scheduleLayout);
});

onBeforeUnmount(() => {
  if (layoutFrame) cancelAnimationFrame(layoutFrame);
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
  return [...ids];
}

/**
 * Scrolls a block into view: centred, or to the top for a heading picked in
 * the index (`align: "start"`), which also takes the focus there so the
 * keyboard and screen readers carry on from it. Otherwise it is focused when
 * the view is interactive.
 */
function scrollToBlock(
  blockId: string,
  options: { align?: "center" | "start" } = {},
): void {
  const element = contentEl.value?.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(blockId)}"]`,
  );
  if (!element) return;
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const start = options.align === "start";
  element.scrollIntoView({
    block: start ? "start" : "center",
    behavior: reduceMotion ? "auto" : "smooth",
  });
  if (start && !selectableBlocks.value) {
    element.tabIndex = -1;
    element.addEventListener(
      "blur",
      () => {
        if (!selectableBlocks.value) element.removeAttribute("tabindex");
      },
      { once: true },
    );
  }
  if (start || selectableBlocks.value) element.focus({ preventScroll: true });
}

defineExpose({
  getSelectedBlockIds,
  scrollToBlock,
  currentHeading,
  outline,
  root: contentEl,
});
</script>

<template>
  <div
    ref="containerEl"
    class="cx-view relative min-w-0"
    :class="{
      'cx-has-gutter': hasMarkers,
      'cx-interactive': interactive,
      'cx-selectable': selectableBlocks,
    }"
  >
    <div v-if="hasMarkers && html" class="cx-gutter">
      <template v-for="[id, marker] in markerEntries" :key="id">
        <template v-if="positions[id] !== undefined">
          <button
            v-if="interactive"
            type="button"
            class="cx-marker"
            :class="{ 'cx-marker--overlap': marker.overlap }"
            :style="{ top: `${positions[id]}px` }"
            :aria-label="markerLabel(marker)"
            :title="markerLabel(marker)"
            @click="onMarkerClick(id, $event)"
          >
            {{ marker.count }}
          </button>
          <span
            v-else
            role="img"
            class="cx-marker"
            :class="{ 'cx-marker--overlap': marker.overlap }"
            :style="{ top: `${positions[id]}px` }"
            :aria-label="markerLabel(marker)"
            :title="markerLabel(marker)"
          >
            {{ marker.count }}
          </span>
        </template>
      </template>
    </div>

    <!-- eslint-disable vue/no-v-html -- render.ts escapes all text and filters links -->
    <div
      v-if="html"
      ref="contentEl"
      class="rich-text cx-content"
      @click="onClick"
      @keydown="onKeydown"
      v-html="html"
    />
    <!-- eslint-enable vue/no-v-html -->
    <slot v-else name="empty">
      <p class="text-muted text-sm">{{ t("common.content.empty") }}</p>
    </slot>
  </div>
</template>

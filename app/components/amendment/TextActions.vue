<script setup lang="ts">
import type { ContextMenuItem } from "@nuxt/ui";
import type { TextSpan } from "~/composables/document/documentLinks";
import {
  keyMayShowSelectionBar,
  selectionBarPlacement,
  type BarPlacement,
} from "./-selectionBar";

/**
 * Acting from the text itself: a right click (or a long press) on the
 * published text it wraps opens a menu, like the editor's; selecting some
 * of it with a mouse or the keyboard shows a small bar over the selection
 * with the same two actions, so nobody has to know about the right click.
 *
 * - "Hacer enmienda aquí" (`amend`, for whoever may amend): the editor
 *   opens at that paragraph and, when the reader had some text selected,
 *   with that text selected, ready to be written over. A shortcut of
 *   "Presentar enmienda": it creates nothing, it only says where the
 *   editor opens.
 * - "Añadir nota aquí" (`note`, where the account keeps private notes):
 *   a note on the selected text, or on the whole paragraph without one.
 * - "Copiar" stays, since the menu takes the place of the browser's own;
 *   Shift with the right click still opens that one.
 *
 * The bar carries only the two actions (copying a selection needs no
 * button). It shows once the selection is made, never while dragging; it
 * never takes the focus, and Escape, a press elsewhere or losing the
 * selection hide it. Not on a touch screen: the system's own selection
 * menu sits there, and the long press already opens the menu.
 *
 * With neither action it is just its content.
 */
const props = withDefaults(
  defineProps<{
    /** The viewer may amend this text now. */
    amend?: boolean;
    /** The account keeps private notes on this text. */
    note?: boolean;
    /** Blocks that can be amended (the base's); every block by default. */
    accept?: (blockId: string) => boolean;
  }>(),
  { amend: false, note: false, accept: undefined },
);

const emit = defineEmits<{
  /** Open the editor at this block, with this text selected if any. */
  amend: [blockId: string, span: TextSpan | null];
  /** Write a private note on this block, on this text if any. */
  note: [blockId: string, span: TextSpan | null];
}>();

const { t } = useI18n();

const box = useTemplateRef<HTMLElement>("box");

/** Where the menu was opened: the paragraph, and the selection if any. */
const target = ref<{
  blockId: string;
  span: TextSpan | null;
  text: string;
} | null>(null);

function blockOf(node: Node | null): HTMLElement | null {
  const root = box.value;
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  const block = element?.closest<HTMLElement>("[data-block-id]") ?? null;
  const id = block?.dataset.blockId;
  if (!root || !block || !id || !root.contains(block)) return null;
  return props.accept && !props.accept(id) ? null : block;
}

/** Characters of the block's text before a point of the selection. */
function offsetIn(block: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The text selected inside this view, as a span of its blocks. */
function selectedSpan(): { span: TextSpan; text: string } | null {
  const root = box.value;
  const current = window.getSelection();
  if (!root || !current || current.isCollapsed || current.rangeCount === 0) {
    return null;
  }
  const range = current.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = range.toString();
  if (!text.trim()) return null;
  const startBlock = blockOf(range.startContainer);
  if (!startBlock) return null;
  const endBlock = blockOf(range.endContainer);
  const start = {
    blockId: startBlock.dataset.blockId!,
    offset: offsetIn(startBlock, range.startContainer, range.startOffset),
  };
  // A selection that ends outside the text stops at the end of its block.
  const end = endBlock
    ? {
        blockId: endBlock.dataset.blockId!,
        offset: offsetIn(endBlock, range.endContainer, range.endOffset),
      }
    : {
        blockId: start.blockId,
        offset: (startBlock.textContent ?? "").length,
      };
  return { span: { start, end }, text };
}

/**
 * Before the menu opens: where the click fell. Off a paragraph, or with
 * Shift, the browser's own menu opens instead.
 */
function onContextMenu(event: MouseEvent): void {
  hideBar();
  const selected = selectedSpan();
  const block = blockOf(event.target as Node | null);
  if (event.shiftKey || (!block && !selected)) {
    target.value = null;
    event.stopPropagation();
    return;
  }
  target.value = {
    blockId: selected?.span.start.blockId ?? block!.dataset.blockId!,
    span: selected?.span ?? null,
    text: selected?.text ?? "",
  };
}

/* The bar over the selection */

const bar = useTemplateRef<HTMLElement>("bar");
const barSize = useElementSize(bar, undefined, { box: "border-box" });

/** The selection the bar acts on, while it shows. */
const barTarget = ref<{
  blockId: string;
  span: TextSpan;
  range: Range;
} | null>(null);
const barAt = ref<BarPlacement | null>(null);
/** The selection Escape hid the bar for: it stays hidden until that changes. */
let dismissed: string | null = null;

function spanKey(span: TextSpan): string {
  return JSON.stringify([span.start, span.end]);
}

function hideBar(): void {
  barTarget.value = null;
  barAt.value = null;
}

function placeBar(): void {
  const at = barTarget.value;
  if (!at) return;
  const lines = at.range.getClientRects();
  const first = lines[0];
  const last = lines[lines.length - 1];
  // The text it covered was redrawn (a live update): nothing to point at.
  if (!first || !last) {
    hideBar();
    return;
  }
  barAt.value = selectionBarPlacement(
    first,
    last,
    { width: barSize.width.value, height: barSize.height.value },
    { width: window.innerWidth, height: window.innerHeight },
  );
}

/** Shows the bar over the current selection, if it lies in this text. */
function showBar(): void {
  const selected = selectedSpan();
  const current = window.getSelection();
  if (!selected || !current || current.rangeCount === 0) {
    hideBar();
    return;
  }
  if (dismissed === spanKey(selected.span)) return;
  dismissed = null;
  barTarget.value = {
    blockId: selected.span.start.blockId,
    span: selected.span,
    range: current.getRangeAt(0).cloneRange(),
  };
  placeBar();
}

function inBar(target: EventTarget | null): boolean {
  return target instanceof Node && Boolean(bar.value?.contains(target));
}

// The page renders on the server too, where there is no document to listen to.
const doc = import.meta.client ? document : undefined;
const win = import.meta.client ? window : undefined;

// Pressing anywhere but on the bar starts over: no bar while dragging.
useEventListener(doc, "pointerdown", (event: PointerEvent) => {
  if (!inBar(event.target)) hideBar();
});
useEventListener(doc, "pointerup", (event: PointerEvent) => {
  if (inBar(event.target)) return;
  if (event.pointerType !== "mouse") {
    hideBar();
    return;
  }
  // The browser settles a double or triple click's selection after this.
  setTimeout(showBar, 0);
});
useEventListener(doc, "keyup", (event: KeyboardEvent) => {
  if (keyMayShowSelectionBar(event.key)) showBar();
});
useEventListener(doc, "keydown", (event: KeyboardEvent) => {
  if (event.key !== "Escape") return;
  // Also before the bar shows: a quick Escape after selecting keeps it away.
  const span = barTarget.value?.span ?? selectedSpan()?.span;
  if (!span) return;
  dismissed = spanKey(span);
  hideBar();
});
useEventListener(doc, "selectionchange", () => {
  if (selectedSpan()) return;
  // A selection made again from nothing is a new one, even of the same text.
  dismissed = null;
  hideBar();
});
useEventListener(win, "scroll", placeBar, { capture: true, passive: true });
useEventListener(win, "resize", placeBar, { passive: true });
// Its size is known once it renders: place it again then.
watch([barSize.width, barSize.height], placeBar);

function barAmend(): void {
  const at = barTarget.value;
  if (!at) return;
  hideBar();
  window.getSelection()?.removeAllRanges();
  emit("amend", at.blockId, at.span);
}

function barNote(): void {
  const at = barTarget.value;
  if (!at) return;
  hideBar();
  emit("note", at.blockId, at.span);
}

const items = computed<ContextMenuItem[][]>(() => [
  [
    ...(props.amend
      ? [
          {
            label: t("workspace.amendHere"),
            icon: "i-lucide-pencil-line",
            onSelect: () => {
              const at = target.value;
              if (!at) return;
              window.getSelection()?.removeAllRanges();
              emit("amend", at.blockId, at.span);
            },
          },
        ]
      : []),
    ...(props.note
      ? [
          {
            label: t("notes.addHere"),
            icon: "i-lucide-sticky-note",
            onSelect: () => {
              const at = target.value;
              if (at) emit("note", at.blockId, at.span);
            },
          },
        ]
      : []),
  ],
  [
    {
      label: t("common.editor.contextMenu.copy"),
      icon: "i-lucide-copy",
      kbds: ["meta", "c"],
      disabled: !target.value?.text,
      onSelect: () => {
        const text = target.value?.text;
        if (text) void navigator.clipboard?.writeText(text);
      },
    },
  ],
]);
</script>

<template>
  <div
    v-if="amend || note"
    ref="box"
    data-testid="amend-from-text"
    @contextmenu.capture="onContextMenu"
  >
    <UContextMenu :items="items" :modal="false">
      <!-- The menu's trigger -->
      <div>
        <slot />
      </div>
    </UContextMenu>

    <!-- Pressing it keeps the selection; it never takes the focus away -->
    <div
      v-if="barTarget"
      ref="bar"
      role="toolbar"
      :aria-label="t('workspace.selectionBar.label')"
      data-testid="selection-bar"
      class="border-default bg-default fixed z-40 flex gap-1 rounded-lg border p-1 shadow-lg"
      :class="{ invisible: !barAt || !barSize.width.value }"
      :style="barAt ? { top: `${barAt.top}px`, left: `${barAt.left}px` } : {}"
      @mousedown.prevent
      @contextmenu.prevent.stop
    >
      <UButton
        v-if="amend"
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-pencil-line"
        :label="t('workspace.selectionBar.amend')"
        @click="barAmend"
      />
      <UButton
        v-if="note"
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-sticky-note"
        :label="t('workspace.selectionBar.note')"
        @click="barNote"
      />
    </div>
  </div>
  <slot v-else />
</template>

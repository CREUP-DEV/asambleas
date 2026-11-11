<script setup lang="ts">
import type { ContextMenuItem } from "@nuxt/ui";
import type { TextSpan } from "~/composables/document/documentLinks";

/**
 * Amending from the text itself: a right click (or a long press) on the
 * published text it wraps opens a menu, like the editor's, with "Hacer
 * enmienda aquí". The editor then opens at that paragraph and, when the
 * reader had some text selected, with that text selected, ready to be
 * written over. "Copiar" stays in the menu, since it takes the place of
 * the browser's own; Shift with the right click still opens that one.
 *
 * It is a shortcut of "Presentar enmienda": it creates nothing, it only
 * says where the editor opens (`amend`). Disabled, it is just its content.
 */
const props = withDefaults(
  defineProps<{
    /** The viewer may amend this text now. */
    enabled?: boolean;
    /** Blocks that can be amended (the base's); every block by default. */
    accept?: (blockId: string) => boolean;
  }>(),
  { enabled: true, accept: undefined },
);

const emit = defineEmits<{
  /** Open the editor at this block, with this text selected if any. */
  amend: [blockId: string, span: TextSpan | null];
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

const items = computed<ContextMenuItem[][]>(() => [
  [
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
    v-if="enabled"
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
  </div>
  <slot v-else />
</template>

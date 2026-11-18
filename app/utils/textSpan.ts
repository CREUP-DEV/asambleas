import type { LiveTextSpan } from "~~/shared/types/api";

/**
 * A stretch of a document's text as blocks and character offsets into each
 * block's text as it shows (`data-block-id`, ContentView), so another
 * screen with other line breaks finds the same words: the Mesa's selection
 * on the projection (user's decision of 2026-11-18).
 */

function blockOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  const block = element?.closest<HTMLElement>("[data-block-id]") ?? null;
  return block && root.contains(block) && block.dataset.blockId ? block : null;
}

/** Characters of the block's text before a point. */
function offsetIn(block: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** A range inside `root` as a span of its blocks; null outside or empty. */
export function spanOfRange(
  root: HTMLElement,
  range: Range,
): LiveTextSpan | null {
  if (range.collapsed || !range.toString().trim()) return null;
  const startBlock = blockOf(root, range.startContainer);
  const endBlock = blockOf(root, range.endContainer);
  if (!startBlock || !endBlock) return null;
  return {
    start: {
      blockId: startBlock.dataset.blockId!,
      offset: offsetIn(startBlock, range.startContainer, range.startOffset),
    },
    end: {
      blockId: endBlock.dataset.blockId!,
      offset: offsetIn(endBlock, range.endContainer, range.endOffset),
    },
  };
}

/** The text node and offset at `offset` characters into a block's text. */
function pointIn(
  block: HTMLElement,
  offset: number,
): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (offset <= seen + text.length) {
      return { node: text, offset: Math.max(0, offset - seen) };
    }
    seen += text.length;
    last = text;
  }
  return last ? { node: last, offset: last.length } : null;
}

/** The range of a span in `root`, or null when it lacks one of its blocks. */
export function rangeOfSpan(
  root: HTMLElement,
  span: LiveTextSpan,
): Range | null {
  const find = (id: string) =>
    root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
  const startBlock = find(span.start.blockId);
  const endBlock = find(span.end.blockId);
  if (!startBlock || !endBlock) return null;
  const start = pointIn(startBlock, span.start.offset);
  const end = pointIn(endBlock, span.end.offset);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range.collapsed ? null : range;
}

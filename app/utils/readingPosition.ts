import { scrollParent } from "./outline";

/**
 * The block a reader has at the top of what they see: the first
 * `[data-block-id]` inside `root` that reaches below the top edge of the
 * area that scrolls (the page itself when nothing else does). `accept`
 * leaves blocks out (those an amendment adds, which the base text does not
 * hold). Null when the text is not on screen.
 */
export function blockAtReadingTop(
  root: HTMLElement,
  accept: (blockId: string) => boolean = () => true,
): string | null {
  // Hidden (another pane is showing): nothing is being read.
  if (root.offsetParent === null) return null;
  const parent = scrollParent(root);
  const top = Math.max(parent ? parent.getBoundingClientRect().top : 0, 0);
  for (const element of root.querySelectorAll<HTMLElement>("[data-block-id]")) {
    const id = element.dataset.blockId;
    if (!id || !accept(id)) continue;
    const box = element.getBoundingClientRect();
    if (box.height > 0 && box.bottom > top + 8) return id;
  }
  return null;
}

/** How long a scroll rests before the paragraph on top counts as read. */
export const READING_REST_MS = 1200;

/** How far (px) a text's start must go above the visible top to count. */
export const SCROLLED_INTO_TEXT_TOLERANCE = 8;

/**
 * The geometry of `scrolledIntoText`: `textTop` is the text's top and
 * `areaTop` the top of the area that scrolls it (null for the page), both
 * from `getBoundingClientRect()`. An area partly above the window counts
 * from the window's top edge.
 */
export function isScrolledIntoText(
  textTop: number,
  areaTop: number | null,
): boolean {
  const visibleTop = Math.max(areaTop ?? 0, 0);
  return textTop < visibleTop - SCROLLED_INTO_TEXT_TOLERANCE;
}

/**
 * Whether the reader has scrolled into the text inside `root`: its start has
 * gone above the top edge of the area that scrolls it. False while that
 * start is still in view (the reader is above it, at the page's header on a
 * narrow screen) and when the text is not on screen.
 */
export function scrolledIntoText(root: HTMLElement): boolean {
  if (root.offsetParent === null) return false;
  const parent = scrollParent(root);
  return isScrolledIntoText(
    root.getBoundingClientRect().top,
    parent ? parent.getBoundingClientRect().top : null,
  );
}

/**
 * Whether `element` (a page's header, say) moves with the text inside
 * `root`: the area that scrolls the text holds it too. False when the text
 * scrolls in a box of its own (the workspace's panel on a wide screen).
 */
export function scrollsWithText(
  root: HTMLElement,
  element: HTMLElement,
): boolean {
  const parent = scrollParent(root);
  return parent === null || parent.contains(element);
}

/** What `amendStartBlockId` weighs. */
export interface AmendStartInput {
  /** The first paragraph of the text the reader has selected. */
  selected: string | null;
  /** The paragraph at the top of what the reader sees now. */
  current: string | null;
  /** The last paragraph the reader rested on inside the text. */
  lastRead: string | null;
  /**
   * The reader went back up to the page's header, above a text that
   * scrolls with the page: what they see first is its start, not where
   * they were reading.
   */
  atHeader: boolean;
}

/**
 * Where "Presentar enmienda" opens the editor: the selection first; then,
 * when the reader went back up to the header to press it, the last
 * paragraph they read rather than the text's first one; otherwise the
 * paragraph they have on top (the last one read when the text is not on
 * screen). Null opens the editor at its start.
 */
export function amendStartBlockId(input: AmendStartInput): string | null {
  if (input.selected) return input.selected;
  if (input.atHeader && input.lastRead) return input.lastRead;
  return input.current ?? input.lastRead;
}

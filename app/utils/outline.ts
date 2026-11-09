/**
 * Helpers for a text's index (ContentOutlineRail): the section being read,
 * in the rendered view and in the editor alike.
 */

/** The nearest ancestor that scrolls, or null for the page itself. */
export function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return null;
}

/**
 * The heading of the section being read: of `ids`, in order, the last one
 * (`[data-block-id]` inside `root`) above the reading line, a quarter down
 * the visible text (at least 96 px, clear of sticky bars); the first one
 * before any.
 */
export function headingAtReadingLine(
  root: HTMLElement,
  ids: string[],
): string | null {
  if (ids.length === 0) return null;
  const parent = scrollParent(root);
  const box = parent
    ? parent.getBoundingClientRect()
    : { top: 0, height: window.innerHeight };
  const line = box.top + Math.max(96, box.height / 4);
  let current: string | null = null;
  for (const id of ids) {
    const element = root.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(id)}"]`,
    );
    if (!element) continue;
    if (element.getBoundingClientRect().top > line) break;
    current = id;
  }
  return current ?? ids[0]!;
}

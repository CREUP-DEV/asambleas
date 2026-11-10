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

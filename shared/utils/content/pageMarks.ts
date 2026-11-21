import type { PageMapStart } from "../../types/api";

/**
 * Where a text on screen shows the pages of its PDF (user's decisions of
 * 2026-11-21): «pág. N» beside the block where page N starts. A view of the
 * text with amendments (with the amendment, with what was approved, the
 * comparison) shows the original's pages on the original's blocks: an
 * inserted block takes none, and a page that starts at a block the view
 * leaves out moves to the next block of the original the view shows (before
 * the next page's start), as starting inside it.
 */

/** The page starts one block shows. */
export interface PageMark {
  /** Printed page numbers starting there, in order. */
  pages: number[];
  /** The first one starts inside the block (or near it), not at its top. */
  inside: boolean;
}

/**
 * The marks of a view, by block id. `viewIds` are the blocks the view shows;
 * `order` the blocks of the version the map is for, in order (to move a
 * start whose block the view leaves out; without it such a start is lost).
 */
export function pageMarks(
  viewIds: readonly string[],
  starts: readonly PageMapStart[],
  order: readonly string[] = [],
): Record<string, PageMark> {
  const shown = new Set(viewIds);
  const position = new Map(order.map((id, index) => [id, index]));
  const marks: Record<string, PageMark> = {};
  const add = (blockId: string, page: number, inside: boolean) => {
    const mark = marks[blockId];
    if (mark) {
      if (!mark.pages.includes(page)) mark.pages.push(page);
    } else {
      marks[blockId] = { pages: [page], inside };
    }
  };
  starts.forEach((start, index) => {
    if (shown.has(start.blockId)) {
      add(start.blockId, start.page, start.inside);
      return;
    }
    const from = position.get(start.blockId);
    if (from === undefined) return;
    // Up to the block where the next page starts (that one keeps its own).
    const nextStart = starts
      .slice(index + 1)
      .map((later) => position.get(later.blockId))
      .find((at): at is number => at !== undefined && at > from);
    const until = nextStart ?? order.length;
    for (let at = from + 1; at < until; at += 1) {
      const id = order[at]!;
      if (shown.has(id)) {
        add(id, start.page, true);
        return;
      }
    }
  });
  return marks;
}

/** «pág. 4» or «pág. 4-5»: a block's pages, for its label. */
export function pageRange(pages: readonly number[]): string {
  if (pages.length === 0) return "";
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  return first === last ? String(first) : `${first}-${last}`;
}

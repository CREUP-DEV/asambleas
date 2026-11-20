/**
 * Bringing the head of a keyset-paged activity list up to date without
 * losing what the reader loaded below it (useActivityPages, `refreshHead`).
 * Pure, so it is unit-tested on its own (-pages.test.ts).
 */

/**
 * How a fresh first page joins the list on show:
 * - `merge`: the fresh page, then `tail` (what the list held after the
 *   page's last row); the cursor stays where it was, so «Cargar más» goes
 *   on from the end already loaded.
 * - `reset`: the list starts over from the fresh page: it holds the whole
 *   list (no next page), or it does not reach the rows on show (more new
 *   rows than a page: a gap would be left between them).
 */
export type ActivityHeadMerge<T> =
  { kind: "merge"; tail: T[] } | { kind: "reset" };

/**
 * Joins a fresh first page to the list on show. The fresh rows come first,
 * so a row that changed (redacted, judged again) replaces its old copy;
 * one that left the head (no longer visible) goes, since everything on show
 * down to the page's last row is the page's.
 */
export function mergeActivityHead<T>(
  shown: readonly T[],
  head: { items: readonly T[]; nextCursor: string | null },
  keyOf: (item: T) => string,
): ActivityHeadMerge<T> {
  const last = head.items.at(-1);
  if (!last || head.nextCursor === null) return { kind: "reset" };
  const key = keyOf(last);
  const index = shown.findIndex((item) => keyOf(item) === key);
  if (index === -1) return { kind: "reset" };
  const fresh = new Set(head.items.map(keyOf));
  return {
    kind: "merge",
    tail: shown.slice(index + 1).filter((item) => !fresh.has(keyOf(item))),
  };
}

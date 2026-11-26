/**
 * The assembly hub's scroll between its pages (user's report of
 * 2026-11-26). Every section of an assembly renders inside the hub's panel,
 * whose body is the one scroll area and outlives them: left alone, a page
 * opens at the offset the last one was left at (from the end of an acta's
 * «Consolidado», «Documentos» opened partway down its list). As a browser
 * does with its window: a new page opens at the top, and Back or Forward
 * goes back to where that entry was left. A page that places itself when it
 * opens (an anchor, the document page's own reset, the control sheet's
 * return) is left where it put itself.
 */

/** What the hub knows once the new page is in. */
export interface HubScrollInput {
  /** The offset the last page was left at. */
  left: number;
  /** The offset now. */
  now: number;
  /** The furthest the new page scrolls. */
  max: number;
  /** Reached with Back or Forward. */
  popped: boolean;
  /** Where that history entry was left, when known. */
  saved: number | null;
}

/**
 * Where the hub scrolls to, or null to leave it: a page that moved the
 * scroll itself keeps it (anything but the old offset, which the browser
 * only cuts short to what the new page has).
 */
export function hubScrollTarget(input: HubScrollInput): number | null {
  const kept = Math.min(input.left, Math.max(0, input.max));
  if (Math.abs(input.now - kept) > 1) return null;
  const target = input.popped ? (input.saved ?? 0) : 0;
  return Math.abs(input.now - target) > 1 ? target : null;
}

/** How many offsets are kept, newest last (one per history entry). */
const SAVED_LIMIT = 50;

/** The offsets left at each history entry, by its position. */
export function rememberOffset(
  saved: Map<number, number>,
  position: number,
  offset: number,
): void {
  saved.delete(position);
  saved.set(position, offset);
  while (saved.size > SAVED_LIMIT) {
    saved.delete(saved.keys().next().value!);
  }
}

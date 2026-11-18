import type { LiveScrollAnchor } from "~~/shared/types/api";

/**
 * Where a scrolling box is in a document, told by the block of text or the
 * page at its top and how far into it, so another screen of any size and
 * type size can show the same part (the Mesa's console and the projection,
 * user's decision of 2026-11-18). A text marks its blocks with
 * `data-block-id` (ContentView); a PDF its pages with `data-page`
 * (DocumentPdfPages).
 */

const SELECTORS = { block: "[data-block-id]", page: "[data-page]" } as const;

/** One box of the document, as the box sees it: its top and its height. */
export interface AnchorTarget {
  key: string;
  top: number;
  height: number;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The anchor at the top of a view `scrollTop` high, among targets in
 * document order with tops relative to the scrolled content: the first one
 * whose bottom is below the top of the view, and how far the view's top is
 * into it.
 */
export function anchorAt(
  targets: readonly AnchorTarget[],
  scrollTop: number,
): { key: string; offset: number } | null {
  const target =
    targets.find((entry) => entry.top + entry.height > scrollTop + 1) ??
    targets.at(-1);
  if (!target) return null;
  return {
    key: target.key,
    offset:
      target.height > 0 ? clamp((scrollTop - target.top) / target.height) : 0,
  };
}

/** Where a view should scroll to show `offset` into the target at its top. */
export function scrollTopFor(target: AnchorTarget, offset: number): number {
  return Math.max(0, target.top + clamp(offset) * target.height);
}

/** The targets of a box, tops relative to its scrolled content. */
function targetsOf(box: HTMLElement, kind: keyof typeof SELECTORS) {
  const boxTop = box.getBoundingClientRect().top - box.scrollTop;
  const result: AnchorTarget[] = [];
  let lastBottom = -Infinity;
  for (const element of box.querySelectorAll<HTMLElement>(SELECTORS[kind])) {
    const rect = element.getBoundingClientRect();
    const top = rect.top - boxTop;
    // A block inside another (a list item) is covered by its parent.
    if (kind === "block" && top < lastBottom) continue;
    const key =
      kind === "block"
        ? (element.dataset.blockId ?? "")
        : (element.dataset.page ?? "");
    if (!key) continue;
    result.push({ key, top, height: rect.height });
    lastBottom = top + rect.height;
  }
  return result;
}

/** Where a box is scrolled, as an anchor; null when it shows nothing. */
export function readScrollAnchor(
  box: HTMLElement,
  kind: "block" | "page",
): LiveScrollAnchor | null {
  const found = anchorAt(targetsOf(box, kind), box.scrollTop);
  if (!found) return null;
  const offset = Math.round(found.offset * 1000) / 1000;
  return kind === "block"
    ? { block: found.key, offset }
    : { page: Number(found.key), offset };
}

/**
 * Scrolls a box to an anchor. False when the box does not have it (another
 * document, a page not laid out yet), so the caller can try again.
 */
export function applyScrollAnchor(
  box: HTMLElement,
  anchor: LiveScrollAnchor,
): boolean {
  const kind = "block" in anchor ? "block" : "page";
  const key = "block" in anchor ? anchor.block : String(anchor.page);
  const target = targetsOf(box, kind).find((entry) => entry.key === key);
  if (!target) return false;
  box.scrollTo({ top: scrollTopFor(target, anchor.offset), behavior: "auto" });
  return true;
}

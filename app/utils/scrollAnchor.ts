import type { LiveScrollAnchor, LivePoint } from "~~/shared/types/api";

/**
 * Where a view is in a document, told by the block of text or the page at
 * its top and how far into it, so another screen of any size and type size
 * can show the same part (the Mesa's console and the projection, user's
 * decision of 2026-11-18). A text marks its blocks with `data-block-id`
 * (ContentView); a PDF its pages with `data-page` (DocumentPdfPages).
 * Points (the Mesa's pointer and strokes) are told the same way: the block
 * or page under them and where inside it, as fractions of its box.
 */

const SELECTORS = { block: "[data-block-id]", page: "[data-page]" } as const;
export type AnchorKind = keyof typeof SELECTORS;

/** One box of the document: its top and its height in some frame. */
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
 * document order with tops in the same frame: the first one whose bottom is
 * below the top of the view, and how far the view's top is into it. Before
 * the first target, the first one at 0.
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

function keyOf(element: HTMLElement, kind: AnchorKind): string {
  return kind === "block"
    ? (element.dataset.blockId ?? "")
    : (element.dataset.page ?? "");
}

/**
 * The elements of the document in `scope`, outermost only (a block inside
 * another, a list item, is covered by its parent), in document order.
 */
function elementsOf(scope: HTMLElement, kind: AnchorKind): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const element of scope.querySelectorAll<HTMLElement>(SELECTORS[kind])) {
    if (!keyOf(element, kind)) continue;
    const parent = element.parentElement?.closest(SELECTORS[kind]);
    if (parent && scope.contains(parent)) continue;
    result.push(element);
  }
  return result;
}

/** The targets of `scope`, tops measured from `originTop` (a client Y). */
function targetsOf(
  scope: HTMLElement,
  kind: AnchorKind,
  originTop: number,
): AnchorTarget[] {
  return elementsOf(scope, kind).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      key: keyOf(element, kind),
      top: rect.top - originTop,
      height: rect.height,
    };
  });
}

function toAnchor(
  found: { key: string; offset: number } | null,
  kind: AnchorKind,
): LiveScrollAnchor | null {
  if (!found) return null;
  const offset = Math.round(found.offset * 1000) / 1000;
  return kind === "block"
    ? { block: found.key, offset }
    : { page: Number(found.key), offset };
}

/**
 * Where a view is in the document in `scope`: the view's top is the client
 * Y `viewTop` (the top of the scrolling box, below anything stuck over it).
 * The document may start further down: then it is its start.
 */
export function readViewAnchor(
  scope: HTMLElement,
  kind: AnchorKind,
  viewTop: number,
): LiveScrollAnchor | null {
  return toAnchor(anchorAt(targetsOf(scope, kind, viewTop), 0), kind);
}

/**
 * Scrolls a box to an anchor. False when the box does not have it (another
 * document, a page not laid out yet), so the caller can try again.
 */
export function applyScrollAnchor(
  box: HTMLElement,
  anchor: LiveScrollAnchor,
): boolean {
  const kind: AnchorKind = "block" in anchor ? "block" : "page";
  const key = "block" in anchor ? anchor.block : String(anchor.page);
  const origin = box.getBoundingClientRect().top - box.scrollTop;
  const target = targetsOf(box, kind, origin).find(
    (entry) => entry.key === key,
  );
  if (!target) return false;
  box.scrollTo({ top: scrollTopFor(target, anchor.offset), behavior: "auto" });
  return true;
}

/** The nearest ancestor that scrolls vertically; null for the page. */
export function scrollParentOf(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
    parent = parent.parentElement;
  }
  return null;
}

// Points ------------------------------------------------------------------------

/**
 * The point of the document under a client position: the block or page it
 * falls in (or the nearest one above or below it) and where inside it.
 */
export function pointAt(
  scope: HTMLElement,
  kind: AnchorKind,
  clientX: number,
  clientY: number,
): LivePoint | null {
  let best: { element: HTMLElement; rect: DOMRect; distance: number } | null =
    null;
  for (const element of elementsOf(scope, kind)) {
    const rect = element.getBoundingClientRect();
    const distance =
      clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom
          ? clientY - rect.bottom
          : 0;
    if (!best || distance < best.distance) best = { element, rect, distance };
    if (distance === 0) break;
  }
  if (!best || best.rect.width <= 0 || best.rect.height <= 0) return null;
  const x =
    Math.round(clamp((clientX - best.rect.left) / best.rect.width) * 10000) /
    10000;
  const y =
    Math.round(clamp((clientY - best.rect.top) / best.rect.height) * 10000) /
    10000;
  const key = keyOf(best.element, kind);
  return kind === "block" ? { block: key, x, y } : { page: Number(key), x, y };
}

/**
 * Where a point falls in `layer`'s frame (a box over the document, same
 * scroll), or null when the document there does not have its block or page.
 */
export function pointIn(
  layer: Element,
  scope: HTMLElement,
  point: LivePoint,
): { x: number; y: number } | null {
  const selector =
    "block" in point
      ? `[data-block-id="${CSS.escape(point.block)}"]`
      : `[data-page="${String(point.page)}"]`;
  const element = scope.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const frame = layer.getBoundingClientRect();
  return {
    x: rect.left - frame.left + point.x * rect.width,
    y: rect.top - frame.top + point.y * rect.height,
  };
}

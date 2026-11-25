/**
 * Where a scrolling box must stand so an element inside it is in view, as
 * `scrollIntoView({ block: "nearest" })` would place it, but moving only
 * that box: the console's side column is wider than the folded strip that
 * holds it, and scrollIntoView would also slide that clipped strip sideways.
 *
 * Positions are client coordinates (getBoundingClientRect). Null when the
 * element is already in view, or when it has no height (folded away).
 */
export function nearestScrollTop(
  box: { top: number; height: number; scrollTop: number },
  element: { top: number; height: number },
  margin = 8,
): number | null {
  if (element.height <= 0 || box.height <= 0) return null;
  const top = element.top - box.top;
  const bottom = top + element.height;
  if (top >= margin && bottom <= box.height - margin) return null;
  // Above, or taller than the box: its start at the top.
  if (top < margin || element.height > box.height - 2 * margin) {
    return Math.max(0, box.scrollTop + top - margin);
  }
  return Math.max(0, box.scrollTop + bottom - box.height + margin);
}

/** Where `box` must stand for `element` to start at its top. */
export function startScrollTop(
  box: { top: number; scrollTop: number },
  element: { top: number },
  margin = 8,
): number {
  return Math.max(0, box.scrollTop + element.top - box.top - margin);
}

/**
 * Scrolls `box` so `element` is in view (`nearest`) or starts at its top
 * (`start`), smoothly unless the reader asked for reduced motion.
 */
export function revealIn(
  box: HTMLElement,
  element: HTMLElement,
  block: "nearest" | "start" = "nearest",
): void {
  const boxRect = box.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const top =
    block === "start"
      ? startScrollTop(
          { top: boxRect.top, scrollTop: box.scrollTop },
          { top: rect.top },
        )
      : nearestScrollTop(
          {
            top: boxRect.top,
            height: box.clientHeight,
            scrollTop: box.scrollTop,
          },
          { top: rect.top, height: rect.height },
        );
  if (top === null) return;
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  box.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
}

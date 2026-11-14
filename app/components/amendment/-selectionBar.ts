/**
 * Where the bar that follows a selection of the published text sits
 * (AmendmentTextActions): centred over the first line of the selection,
 * or under its last line when there is no room above, and always inside
 * the window.
 */

export interface BarRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface BarSize {
  width: number;
  height: number;
}

export interface BarPlacement {
  top: number;
  left: number;
}

/** Space between the selection and the bar, and between the bar and the window's edge. */
export const SELECTION_BAR_GAP = 8;

/**
 * The bar's top left corner, in window coordinates, or null when the
 * selection is out of sight (scrolled away) and the bar should not show.
 */
export function selectionBarPlacement(
  first: BarRect,
  last: BarRect,
  bar: BarSize,
  viewport: BarSize,
): BarPlacement | null {
  if (last.bottom < 0 || first.top > viewport.height) return null;
  const gap = SELECTION_BAR_GAP;
  const above = first.top - gap - bar.height;
  const top =
    above >= gap
      ? above
      : Math.min(last.bottom + gap, viewport.height - gap - bar.height);
  const centre = (first.left + first.right) / 2;
  const left = Math.min(
    Math.max(centre - bar.width / 2, gap),
    Math.max(viewport.width - gap - bar.width, gap),
  );
  return { top, left };
}

/** Keys whose release never shows the bar: they select nothing. */
const SILENT_KEYS = new Set(["Escape", "Tab", "Control", "Meta", "Alt"]);

/** Whether releasing this key may show the bar over a keyboard selection. */
export function keyMayShowSelectionBar(key: string): boolean {
  return !SILENT_KEYS.has(key);
}

/**
 * What a click on a row of the sheet's tables (General, Enmiendas) lands on
 * when it is something of the row's own: a link, a button, a form control or
 * the trigger of a click popover (`[aria-haspopup]`). Those keep their own
 * action; anywhere else the row opens its panel. The presenters' tags are
 * hover cards, whose trigger carries no `aria-haspopup` and has no click
 * action of its own, so a click on a tag opens the panel like the rest of the
 * row. Do not add `[data-grace-area-trigger]` to catch them: reka's tooltip
 * triggers carry it too, so every badge with a tooltip would stop opening it.
 */
export const ROW_OWN_CONTROLS =
  "a, button, input, select, textarea, label, [role='button'], [role='link'], [aria-haspopup]";

/** The little of a click's target the rule reads. */
export interface RowClickTarget {
  closest(selectors: string): unknown;
}

/**
 * Whether a click on a row opens its panel: not when it lands on one of the
 * row's own controls (ROW_OWN_CONTROLS), nor when it ends selecting text
 * (`selected`, what the page has selected), so a vote or an observation
 * dragged over can still be copied (a double click, whose first click has
 * nothing selected yet, still opens it). The row itself is never a tab stop: the button at
 * its start is the way in from the keyboard.
 */
export function rowClickOpens(
  target: RowClickTarget | null,
  selected: string,
): boolean {
  if (selected.trim() !== "") return false;
  if (!target || typeof target.closest !== "function") return false;
  return !target.closest(ROW_OWN_CONTROLS);
}

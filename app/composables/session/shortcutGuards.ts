/**
 * When a single-key shortcut of the Mesa console must not act, from where
 * the keyboard focus is. Pure, so it is tested without a browser.
 */

/** What the guard reads of `document.activeElement`. */
export interface ShortcutFocusTarget {
  closest(selector: string): unknown;
  isContentEditable?: boolean;
  tagName?: string;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * True when the focus is in a dialog or a popover (reka gives both
 * `role="dialog"`: the headcount, Preferences, the welcome, the toolbar's
 * popovers) or in an editable element. Menus are not on the list: the card
 * menu announces "l" and "t", and a key pressed there acts on its card.
 */
export function shortcutKeyIgnoredAt(
  active: ShortcutFocusTarget | null | undefined,
): boolean {
  if (!active) return false;
  if (active.isContentEditable) return true;
  if (active.tagName && EDITABLE_TAGS.has(active.tagName.toUpperCase())) {
    return true;
  }
  return Boolean(active.closest('[role="dialog"], [role="alertdialog"]'));
}

/**
 * A decision taken by key ("a", "l") on an amendment that is not the one in
 * debate asks first: the selection may have stayed on another row while the
 * debate moved on from another device.
 */
export function sessionShortcutNeedsConfirm(
  targetId: string,
  debatedId: string | null | undefined,
): boolean {
  return targetId !== (debatedId ?? null);
}

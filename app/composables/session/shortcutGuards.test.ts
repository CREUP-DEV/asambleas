import { describe, expect, it } from "vitest";
import {
  sessionShortcutNeedsConfirm,
  shortcutKeyIgnoredAt,
  type ShortcutFocusTarget,
} from "./shortcutGuards";

function element(
  options: {
    tagName?: string;
    isContentEditable?: boolean;
    inside?: string[];
  } = {},
): ShortcutFocusTarget {
  const inside = options.inside ?? [];
  return {
    tagName: options.tagName ?? "BUTTON",
    isContentEditable: options.isContentEditable ?? false,
    closest: (selector: string) =>
      inside.some((role) => selector.includes(`[role="${role}"]`)) ? {} : null,
  };
}

describe("shortcutKeyIgnoredAt", () => {
  it("lets a key through with nothing focused or on a plain button", () => {
    expect(shortcutKeyIgnoredAt(null)).toBe(false);
    expect(shortcutKeyIgnoredAt(undefined)).toBe(false);
    expect(shortcutKeyIgnoredAt(element())).toBe(false);
  });

  it("ignores keys inside a dialog or a popover", () => {
    expect(shortcutKeyIgnoredAt(element({ inside: ["dialog"] }))).toBe(true);
    expect(shortcutKeyIgnoredAt(element({ inside: ["alertdialog"] }))).toBe(
      true,
    );
  });

  it("ignores keys in editable elements", () => {
    expect(shortcutKeyIgnoredAt(element({ tagName: "INPUT" }))).toBe(true);
    expect(shortcutKeyIgnoredAt(element({ tagName: "textarea" }))).toBe(true);
    expect(shortcutKeyIgnoredAt(element({ tagName: "SELECT" }))).toBe(true);
    expect(
      shortcutKeyIgnoredAt(
        element({ tagName: "DIV", isContentEditable: true }),
      ),
    ).toBe(true);
  });

  it("keeps the shortcuts in a menu, which announces them", () => {
    expect(shortcutKeyIgnoredAt(element({ inside: ["menu"] }))).toBe(false);
  });
});

describe("sessionShortcutNeedsConfirm", () => {
  it("acts at once on the amendment in debate", () => {
    expect(sessionShortcutNeedsConfirm("a1", "a1")).toBe(false);
  });

  it("asks first for any other amendment, or with nothing in debate", () => {
    expect(sessionShortcutNeedsConfirm("a1", "a2")).toBe(true);
    expect(sessionShortcutNeedsConfirm("a1", null)).toBe(true);
    expect(sessionShortcutNeedsConfirm("a1", undefined)).toBe(true);
  });
});

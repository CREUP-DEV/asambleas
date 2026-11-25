import { describe, expect, it } from "vitest";
import {
  ROW_OWN_CONTROLS,
  rowClickOpens,
  type RowClickTarget,
} from "./-rowClick";

/** A target inside a control (or not), as `closest` would find it. */
function target(insideControl: boolean): RowClickTarget & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    closest(selectors: string) {
      asked.push(selectors);
      return insideControl ? {} : null;
    },
  };
}

describe("rowClickOpens", () => {
  it("opens the panel from a plain part of the row", () => {
    const plain = target(false);
    expect(rowClickOpens(plain, "")).toBe(true);
    expect(plain.asked).toEqual([ROW_OWN_CONTROLS]);
  });

  it("leaves the row's own links, buttons and popovers their action", () => {
    expect(rowClickOpens(target(true), "")).toBe(false);
  });

  it("does not open while the reader selects text", () => {
    expect(rowClickOpens(target(false), "A favor 12")).toBe(false);
    // Only blanks selected: a click, not a selection.
    expect(rowClickOpens(target(false), " \n")).toBe(true);
  });

  it("does not open without an element to judge", () => {
    expect(rowClickOpens(null, "")).toBe(false);
    expect(rowClickOpens({} as RowClickTarget, "")).toBe(false);
  });

  it("names every kind of control a row holds", () => {
    for (const selector of [
      "a",
      "button",
      "input",
      "label",
      "[role='button']",
      "[aria-haspopup]",
    ]) {
      expect(ROW_OWN_CONTROLS.split(", ")).toContain(selector);
    }
  });
});

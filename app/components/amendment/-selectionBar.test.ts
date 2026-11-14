import { describe, expect, it } from "vitest";
import {
  SELECTION_BAR_GAP,
  keyMayShowSelectionBar,
  selectionBarPlacement,
} from "./-selectionBar";

const viewport = { width: 1000, height: 800 };
const bar = { width: 200, height: 40 };
const line = (top: number, left = 300, right = 500) => ({
  top,
  bottom: top + 20,
  left,
  right,
});

describe("selectionBarPlacement", () => {
  it("sits centred over the first line", () => {
    expect(selectionBarPlacement(line(400), line(440), bar, viewport)).toEqual({
      top: 400 - SELECTION_BAR_GAP - 40,
      left: 300,
    });
  });

  it("goes under the last line when there is no room above", () => {
    expect(selectionBarPlacement(line(20), line(60), bar, viewport)).toEqual({
      top: 80 + SELECTION_BAR_GAP,
      left: 300,
    });
  });

  it("stays inside the window at both edges", () => {
    expect(
      selectionBarPlacement(line(400, 0, 40), line(400), bar, viewport)?.left,
    ).toBe(SELECTION_BAR_GAP);
    expect(
      selectionBarPlacement(line(400, 950, 1000), line(400), bar, viewport)
        ?.left,
    ).toBe(1000 - SELECTION_BAR_GAP - 200);
  });

  it("never goes below the window for a selection taller than it", () => {
    expect(selectionBarPlacement(line(10), line(900), bar, viewport)?.top).toBe(
      800 - SELECTION_BAR_GAP - 40,
    );
  });

  it("hides when the selection is scrolled out of sight", () => {
    expect(selectionBarPlacement(line(-200), line(-100), bar, viewport)).toBe(
      null,
    );
    expect(selectionBarPlacement(line(900), line(950), bar, viewport)).toBe(
      null,
    );
  });
});

describe("keyMayShowSelectionBar", () => {
  it("ignores keys that select nothing", () => {
    expect(keyMayShowSelectionBar("Escape")).toBe(false);
    expect(keyMayShowSelectionBar("Tab")).toBe(false);
    expect(keyMayShowSelectionBar("Control")).toBe(false);
    expect(keyMayShowSelectionBar("Shift")).toBe(true);
    expect(keyMayShowSelectionBar("ArrowRight")).toBe(true);
  });
});

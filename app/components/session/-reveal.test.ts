import { describe, expect, it } from "vitest";
import { nearestScrollTop, startScrollTop } from "./-reveal";

const box = { top: 100, height: 400, scrollTop: 1000 };

describe("nearestScrollTop", () => {
  it("leaves an element already in view where it is", () => {
    expect(nearestScrollTop(box, { top: 200, height: 40 })).toBeNull();
  });

  it("brings an element above the view to the top, with a margin", () => {
    // 50 px above the box's top: scroll up by 50 + 8.
    expect(nearestScrollTop(box, { top: 50, height: 40 })).toBe(942);
  });

  it("brings an element below the view to the bottom, with a margin", () => {
    // Its bottom at 600 + 40 - 100 = 540 inside the box, 400 tall.
    expect(nearestScrollTop(box, { top: 600, height: 40 })).toBe(1148);
  });

  it("puts the start of an element taller than the box at the top", () => {
    expect(nearestScrollTop(box, { top: 700, height: 900 })).toBe(1592);
  });

  it("never scrolls above the start", () => {
    expect(
      nearestScrollTop({ ...box, scrollTop: 0 }, { top: 0, height: 40 }),
    ).toBe(0);
  });

  it("puts an element's start at the top on request", () => {
    expect(startScrollTop(box, { top: 300 })).toBe(1192);
    expect(startScrollTop({ top: 100, scrollTop: 0 }, { top: 50 })).toBe(0);
  });

  it("does nothing for a folded element or box", () => {
    expect(nearestScrollTop(box, { top: 900, height: 0 })).toBeNull();
    expect(
      nearestScrollTop({ ...box, height: 0 }, { top: 900, height: 40 }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { hubScrollTarget, rememberOffset } from "./-hubScroll";

const base = { left: 2400, now: 2400, max: 5000, popped: false, saved: null };

describe("hubScrollTarget", () => {
  it("opens a new page at the top, not at the old offset", () => {
    expect(hubScrollTarget(base)).toBe(0);
  });

  it("does the same when the new page is shorter than the old offset", () => {
    expect(hubScrollTarget({ ...base, now: 900, max: 900 })).toBe(0);
  });

  it("leaves a page that placed itself", () => {
    // An anchor, the document page's own reset, the control sheet's return.
    expect(hubScrollTarget({ ...base, now: 640 })).toBeNull();
    expect(hubScrollTarget({ ...base, now: 0 })).toBeNull();
  });

  it("goes back to where a history entry was left", () => {
    expect(hubScrollTarget({ ...base, popped: true, saved: 1200 })).toBe(1200);
  });

  it("opens at the top an entry it knows nothing of", () => {
    expect(hubScrollTarget({ ...base, popped: true })).toBe(0);
  });

  it("does nothing when already there", () => {
    expect(hubScrollTarget({ ...base, left: 0, now: 0 })).toBeNull();
  });
});

describe("rememberOffset", () => {
  it("keeps the latest offset per entry and forgets the oldest", () => {
    const saved = new Map<number, number>();
    for (let position = 0; position < 60; position++) {
      rememberOffset(saved, position, position * 10);
    }
    rememberOffset(saved, 55, 1);
    expect(saved.size).toBe(50);
    expect(saved.has(0)).toBe(false);
    expect(saved.get(55)).toBe(1);
    expect([...saved.keys()].at(-1)).toBe(55);
  });
});

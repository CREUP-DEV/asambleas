import { describe, expect, it } from "vitest";
import { anchorAt, scrollTopFor } from "./scrollAnchor";

const TARGETS = [
  { key: "a", top: 0, height: 100 },
  { key: "b", top: 100, height: 200 },
  { key: "c", top: 300, height: 50 },
];

describe("anchorAt", () => {
  it("takes the block at the top of the view and how far into it", () => {
    expect(anchorAt(TARGETS, 0)).toEqual({ key: "a", offset: 0 });
    expect(anchorAt(TARGETS, 50)).toEqual({ key: "a", offset: 0.5 });
    expect(anchorAt(TARGETS, 150)).toEqual({ key: "b", offset: 0.25 });
  });

  it("moves on once a block is all above the view", () => {
    expect(anchorAt(TARGETS, 100)).toEqual({ key: "b", offset: 0 });
  });

  it("stays on the last block past the end, and is null with none", () => {
    expect(anchorAt(TARGETS, 900)).toEqual({ key: "c", offset: 1 });
    expect(anchorAt([], 0)).toBeNull();
  });
});

describe("scrollTopFor", () => {
  it("puts the same part of the block at the top, whatever its size", () => {
    expect(scrollTopFor({ key: "b", top: 400, height: 800 }, 0.25)).toBe(600);
    expect(scrollTopFor({ key: "a", top: 0, height: 100 }, 2)).toBe(100);
  });
});

import { describe, expect, it } from "vitest";
import { pageMarks, pageRange } from "./pageMarks";

const start = (blockId: string, page: number, inside = false) => ({
  blockId,
  page,
  inside,
});

describe("pageMarks", () => {
  const order = ["a", "b", "c", "d", "e"];
  const starts = [start("a", 1), start("c", 2), start("e", 3, true)];

  it("marks the blocks where pages start in the text itself", () => {
    expect(pageMarks(order, starts, order)).toEqual({
      a: { pages: [1], inside: false },
      c: { pages: [2], inside: false },
      e: { pages: [3], inside: true },
    });
  });

  it("gives an inserted block no page and keeps the original's", () => {
    // «Con la enmienda»: n1 inserted before c.
    const view = ["a", "b", "n1", "c", "d", "e"];
    expect(pageMarks(view, starts, order)).toEqual({
      a: { pages: [1], inside: false },
      c: { pages: [2], inside: false },
      e: { pages: [3], inside: true },
    });
  });

  it("moves a start whose block the view leaves out to the next one it shows", () => {
    // c deleted and not shown: page 2 begins at d, near its top.
    const view = ["a", "b", "d", "e"];
    expect(pageMarks(view, starts, order)).toEqual({
      a: { pages: [1], inside: false },
      d: { pages: [2], inside: true },
      e: { pages: [3], inside: true },
    });
  });

  it("never moves a start past the next page's own block", () => {
    // c and d gone: page 2 would land on e, which starts page 3 itself.
    const view = ["a", "b", "e"];
    expect(pageMarks(view, starts, order)).toEqual({
      a: { pages: [1], inside: false },
      e: { pages: [3], inside: true },
    });
  });

  it("joins the pages a long block runs on to", () => {
    const marks = pageMarks(
      ["a", "b"],
      [start("a", 1), start("a", 2, true), start("a", 3, true), start("b", 4)],
    );
    expect(marks).toEqual({
      a: { pages: [1, 2, 3], inside: false },
      b: { pages: [4], inside: false },
    });
  });

  it("drops a start it cannot place without the version's order", () => {
    expect(pageMarks(["a"], [start("a", 1), start("x", 2)])).toEqual({
      a: { pages: [1], inside: false },
    });
  });
});

describe("pageRange", () => {
  it("reads one page or a run", () => {
    expect(pageRange([4])).toBe("4");
    expect(pageRange([4, 5, 6])).toBe("4-6");
    expect(pageRange([])).toBe("");
  });
});

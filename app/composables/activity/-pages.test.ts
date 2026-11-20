import { describe, expect, it } from "vitest";
import { mergeActivityHead } from "./-pages";

interface Row {
  id: string;
  text?: string;
}
const keyOf = (row: Row) => row.id;
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

describe("mergeActivityHead", () => {
  it("puts the new rows on top and keeps what was loaded below", () => {
    // Two pages of three loaded (a..f); two new rows arrive.
    const shown = rows("a", "b", "c", "d", "e", "f");
    const result = mergeActivityHead(
      shown,
      { items: rows("x", "y", "a"), nextCursor: "after-a" },
      keyOf,
    );
    expect(result).toEqual({
      kind: "merge",
      tail: rows("b", "c", "d", "e", "f"),
    });
  });

  it("replaces a row that changed rather than showing it twice", () => {
    const shown: Row[] = [{ id: "a", text: "old" }, ...rows("b", "c", "d")];
    const head = {
      items: [{ id: "x" }, { id: "a", text: "redacted" }, { id: "b" }],
      nextCursor: "after-b",
    };
    const result = mergeActivityHead(shown, head, keyOf);
    expect(result).toEqual({ kind: "merge", tail: rows("c", "d") });
  });

  it("drops a row of the head that is no longer shown to the reader", () => {
    const shown = rows("a", "b", "c", "d", "e");
    // "b" is no longer visible: the fresh page goes down to "d".
    const result = mergeActivityHead(
      shown,
      { items: rows("x", "a", "c", "d"), nextCursor: "after-d" },
      keyOf,
    );
    expect(result).toEqual({ kind: "merge", tail: rows("e") });
  });

  it("keeps the list as it was when nothing changed", () => {
    const shown = rows("a", "b", "c", "d");
    expect(
      mergeActivityHead(
        shown,
        { items: rows("a", "b"), nextCursor: "after-b" },
        keyOf,
      ),
    ).toEqual({ kind: "merge", tail: rows("c", "d") });
  });

  it("starts over when more new rows came than a page holds", () => {
    expect(
      mergeActivityHead(
        rows("a", "b", "c"),
        { items: rows("x", "y", "z"), nextCursor: "after-z" },
        keyOf,
      ),
    ).toEqual({ kind: "reset" });
  });

  it("starts over when the fresh page is the whole list", () => {
    expect(
      mergeActivityHead(
        rows("a", "b"),
        { items: rows("x", "a", "b"), nextCursor: null },
        keyOf,
      ),
    ).toEqual({ kind: "reset" });
    expect(
      mergeActivityHead(rows("a"), { items: [], nextCursor: null }, keyOf),
    ).toEqual({ kind: "reset" });
  });
});

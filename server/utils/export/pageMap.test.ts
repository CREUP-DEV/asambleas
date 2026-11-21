import { describe, expect, it } from "vitest";
import {
  buildPageMap,
  pageLayoutKey,
  type PageLayoutInputs,
  type RawPageTag,
} from "./pageMap";

const raw = (total: number, tags: RawPageTag[]) => ({ total, tags });

describe("buildPageMap", () => {
  it("starts each page at the first block on it", () => {
    const map = buildPageMap(
      ["a", "b", "c", "d"],
      raw(3, [
        ["a", 1, 1, 0],
        ["b", 1, 1, 0],
        ["c", 2, 2, 0],
        ["d", 3, 3, 0],
      ]),
      0,
    );
    expect(map).toEqual({
      total: 3,
      starts: [
        { blockId: "a", page: 1, inside: false },
        { blockId: "c", page: 2, inside: false },
        { blockId: "d", page: 3, inside: false },
      ],
    });
  });

  it("starts a page inside the block that runs on to it", () => {
    const map = buildPageMap(
      ["a", "b", "c"],
      raw(4, [
        ["a", 1, 1, 0],
        ["b", 1, 3, 0],
        ["c", 3, 4, 0],
      ]),
      0,
    );
    expect(map.starts).toEqual([
      { blockId: "a", page: 1, inside: false },
      { blockId: "b", page: 2, inside: true },
      { blockId: "b", page: 3, inside: true },
      { blockId: "c", page: 4, inside: true },
    ]);
  });

  it("counts pages as the footer does, after a cover", () => {
    const map = buildPageMap(
      ["a", "b"],
      raw(3, [
        ["a", 2, 2, 0],
        ["b", 3, 3, 0],
      ]),
      1,
    );
    expect(map).toEqual({
      total: 2,
      starts: [
        { blockId: "a", page: 1, inside: false },
        { blockId: "b", page: 2, inside: false },
      ],
    });
  });

  it("follows the text's order, whatever order the nodes came in", () => {
    const map = buildPageMap(
      ["a", "b"],
      raw(2, [
        ["b", 2, 2, 0],
        ["a", 1, 1, 0],
        // A block the text no longer has is ignored.
        ["gone", 1, 2, 0],
      ]),
      0,
    );
    expect(map.starts.map((start) => start.blockId)).toEqual(["a", "b"]);
  });

  it("gives a header row the next row's page and an image in a cell the previous block's", () => {
    const map = buildPageMap(
      ["p", "head", "row1", "img", "row2"],
      raw(3, [
        ["p", 1, 1, 0],
        ["head", null, null, 1],
        ["row1", 2, 2, 0],
        ["img", null, null, 0],
        ["row2", 3, 3, 0],
      ]),
      0,
    );
    expect(map.starts).toEqual([
      { blockId: "p", page: 1, inside: false },
      { blockId: "head", page: 2, inside: false },
      { blockId: "row2", page: 3, inside: false },
    ]);
  });

  it("leaves out a page that holds no block and keeps the PDF's total", () => {
    const map = buildPageMap(
      ["a", "b"],
      raw(4, [
        ["a", 1, 1, 0],
        ["b", 3, 3, 0],
      ]),
      0,
    );
    expect(map).toEqual({
      total: 4,
      starts: [
        { blockId: "a", page: 1, inside: false },
        { blockId: "b", page: 3, inside: false },
      ],
    });
  });

  it("joins the nodes of one block", () => {
    const map = buildPageMap(
      ["a", "b"],
      raw(2, [
        ["a", 1, 1, 0],
        ["a", 2, 2, 0],
        ["b", 2, 2, 0],
      ]),
      0,
    );
    expect(map.starts).toEqual([
      { blockId: "a", page: 1, inside: false },
      { blockId: "a", page: 2, inside: true },
    ]);
  });

  it("has no start for an empty text", () => {
    expect(buildPageMap([], raw(1, []), 0)).toEqual({ total: 1, starts: [] });
  });
});

describe("pageLayoutKey", () => {
  const inputs: PageLayoutInputs = {
    locale: "es",
    versionId: "v1",
    version: "consolidated",
    title: "Reglamento",
    kind: "regulation",
    assembly: { label: "80.ª AGO", number: 80, type: "AGO" },
    finalVote: {
      inFavor: 30,
      against: 2,
      abstentions: 1,
      blank: 0,
      majority: "simple",
      result: "approved",
      method: "show_of_hands",
      unanimous: false,
      recordedAt: new Date("2026-11-21T10:00:00Z"),
    } as PageLayoutInputs["finalVote"],
    pendingConciliation: [],
  };
  const key = pageLayoutKey(inputs, 2);

  it("is stable for the same inputs", () => {
    expect(pageLayoutKey({ ...inputs }, 2)).toBe(key);
  });

  it.each<[string, Partial<PageLayoutInputs>]>([
    ["the version", { versionId: "v2" }],
    ["the title", { title: "Reglamento interno" }],
    ["the kind (a cover)", { kind: "positioning" }],
    ["the language", { locale: "en" }],
    [
      "the assembly",
      { assembly: { label: "81.ª AGO", number: 81, type: "AGO" } },
    ],
    ["the vote", { finalVote: { ...inputs.finalVote!, inFavor: 31 } }],
    ["a vote annulled", { finalVote: null }],
    [
      "a passage pending conciliation",
      { pendingConciliation: [{ blockId: "b1", codes: ["E3", "E5"] }] },
    ],
  ])("changes with %s", (_, change) => {
    expect(pageLayoutKey({ ...inputs, ...change }, 2)).not.toBe(key);
  });

  it("changes with the renderer", () => {
    expect(pageLayoutKey(inputs, 3)).not.toBe(key);
  });

  it("ignores the vote for the text as presented", () => {
    const base = { ...inputs, version: "base" as const };
    expect(pageLayoutKey({ ...base, finalVote: null }, 2)).toBe(
      pageLayoutKey(base, 2),
    );
  });
});

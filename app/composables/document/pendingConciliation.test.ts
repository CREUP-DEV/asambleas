import { describe, expect, it } from "vitest";
import type { Block } from "~~/shared/types/content";
import {
  amendmentCodeIn,
  joinCodes,
  pendingPassageMarks,
  pendingPassagesOfVersion,
  sameBlocks,
} from "./pendingConciliation";

describe("sameBlocks", () => {
  const block: Block = {
    id: "b1",
    type: "paragraph",
    text: "Las ratios",
    marks: [{ type: "bold", from: 0, to: 3 }],
  };
  it("reads blocks stored with their keys in another order as the same", () => {
    const stored = JSON.parse(
      '[{"marks":[{"to":3,"from":0,"type":"bold"}],"text":"Las ratios","type":"paragraph","id":"b1"}]',
    ) as Block[];
    expect(sameBlocks([block], stored)).toBe(true);
  });
  it("reads nested objects stored with their keys in another order as the same", () => {
    const cell: Block = {
      id: "c1",
      type: "paragraph",
      cell: { table: "t1", row: "r1", cell: "k1", header: true },
      text: "Uno",
      marks: [],
    };
    const stored = JSON.parse(
      '[{"id":"c1","cell":{"row":"r1","cell":"k1","table":"t1","header":true},"text":"Uno","type":"paragraph","marks":[]}]',
    ) as Block[];
    expect(sameBlocks([cell], stored)).toBe(true);
    expect(
      sameBlocks(
        [cell],
        [{ ...cell, cell: { table: "t1", row: "r1", cell: "k1" } }],
      ),
    ).toBe(false);
  });
  it("tells a correction of text or of format apart", () => {
    expect(sameBlocks([block], [{ ...block, text: "Los ratios" }])).toBe(false);
    expect(sameBlocks([block], [{ ...block, marks: [] }])).toBe(false);
    expect(sameBlocks([block], [{ ...block, type: "heading", level: 2 }])).toBe(
      false,
    );
    expect(sameBlocks([block], [])).toBe(false);
    expect(sameBlocks(null, [block])).toBe(false);
  });
});

const version = {
  pendingPassages: [
    {
      key: "a,b|b2",
      amendmentIds: ["a", "b"],
      blockIds: ["b2"],
      textBlockIds: ["b2", "n1"],
    },
    {
      key: "c,d,e|b5",
      amendmentIds: ["c", "d", "e"],
      blockIds: ["b5"],
      textBlockIds: ["b5"],
    },
  ],
};

const codes: Record<string, string> = {
  a: "E3",
  b: "E5",
  c: "E7",
  d: "E8",
  e: "E9",
};

describe("amendmentCodeIn", () => {
  it("reads an amendment's code, its number before it has one, or ?", () => {
    const label = amendmentCodeIn([
      { id: "a", code: "E3", number: 3 },
      { id: "b", code: null, number: 5 },
    ]);
    expect(label("a")).toBe("E3");
    expect(label("b")).toBe("#5");
    expect(label("x")).toBe("?");
  });
});

describe("joinCodes", () => {
  it("joins codes the locale's way", () => {
    expect(joinCodes(["E3", "E5"], "es")).toBe("E3 y E5");
    expect(joinCodes(["E3", "E5", "E7"], "en")).toBe("E3, E5, and E7");
    expect(joinCodes(["E3"], "es")).toBe("E3");
  });
});

describe("pendingPassageMarks", () => {
  it("marks each passage's blocks in the text with the codes the reader reads", () => {
    expect(
      pendingPassageMarks(version, {
        label: (id) => codes[id] ?? "?",
        locale: "es",
        text: (joined) => `Pendiente de conciliar ${joined}`,
      }),
    ).toEqual([
      {
        key: "a,b|b2",
        blockIds: ["b2", "n1"],
        label: "Pendiente de conciliar E3 y E5",
      },
      {
        key: "c,d,e|b5",
        blockIds: ["b5"],
        label: "Pendiente de conciliar E7, E8 y E9",
      },
    ]);
  });

  it("marks nothing in a final text", () => {
    expect(pendingPassagesOfVersion(null)).toEqual([]);
    expect(
      pendingPassageMarks(
        { pendingPassages: [] },
        { label: String, locale: "es", text: String },
      ),
    ).toEqual([]);
  });
});

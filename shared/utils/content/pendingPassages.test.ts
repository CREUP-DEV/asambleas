import { describe, expect, it } from "vitest";
import type { Block, ReplaceOp } from "../../types/content";
import { consolidateApproved } from "./passages";
import {
  pendingPassagesOf,
  pendingPassageStarts,
  storedPendingPassages,
  withBlockNotes,
} from "./pendingPassages";

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const base: Block[] = [
  p(
    "b1",
    "La infrafinanciación de las universidades públicas y la falta de contratación obliga a repartir más estudiantes.",
  ),
  p("b2", "Las ratios se disparan en muchas asignaturas."),
  p("b3", "Hace falta un modelo centrado en el estudiantado."),
];

function replace(blockId: string, find: string, text: string): ReplaceOp {
  const block = base.find((item) => item.id === blockId)!;
  const from = block.text.indexOf(find);
  if (from < 0) throw new Error(`"${find}" is not in ${blockId}`);
  return {
    op: "replace",
    blockId,
    from,
    to: from + find.length,
    text,
    baseText: find,
  };
}

function insertAfter(blockId: string, after: string, text: string): ReplaceOp {
  const block = base.find((item) => item.id === blockId)!;
  const at = block.text.indexOf(after) + after.length;
  return { op: "replace", blockId, from: at, to: at, text, baseText: "" };
}

// Touching changes in b1, the same text changed twice in b2.
const um2 = { id: "UM2", ops: [insertAfter("b1", "contratación ", "de PDI ")] };
const uex6 = {
  id: "UEX6",
  ops: [replace("b1", "y la falta de contratación ", "")],
};
const a = { id: "A", ops: [replace("b2", "muchas", "bastantes")] };
const b = {
  id: "B",
  ops: [replace("b2", "en muchas asignaturas", "en asignaturas troncales")],
};

const text = (blocks: Block[], id: string) =>
  blocks.find((block) => block.id === id)?.text;

describe("pendingPassagesOf", () => {
  it("lists the passages a final vote leaves pending, with their blocks in the text", () => {
    const outcome = consolidateApproved(base, [um2, uex6, a, b]);
    expect(pendingPassagesOf(outcome)).toEqual([
      {
        key: "UEX6,UM2|b1",
        amendmentIds: ["UM2", "UEX6"],
        blockIds: ["b1"],
        textBlockIds: ["b1"],
      },
      {
        key: "A,B|b2",
        amendmentIds: ["A", "B"],
        blockIds: ["b2"],
        textBlockIds: ["b2"],
      },
    ]);
  });

  it("keeps only the keys asked for", () => {
    const outcome = consolidateApproved(base, [um2, uex6, a, b]);
    expect(
      pendingPassagesOf(outcome, new Set(["A,B|b2"])).map((item) => item.key),
    ).toEqual(["A,B|b2"]);
  });

  it("drops a passage once it is worded, and leaves the rest of the text as the vote stored it", () => {
    const voted = consolidateApproved(base, [um2, uex6, a, b]);
    const conciliated = consolidateApproved(base, [um2, uex6, a, b], {
      wordings: [
        {
          id: "w1",
          amendmentIds: ["UM2", "UEX6"],
          blockIds: ["b1"],
          ops: [
            replace("b1", "y la falta de contratación ", "y la falta de PDI "),
          ],
        },
      ],
    });
    expect(
      pendingPassagesOf(conciliated, new Set(["UEX6,UM2|b1", "A,B|b2"])),
    ).toEqual([
      {
        key: "A,B|b2",
        amendmentIds: ["A", "B"],
        blockIds: ["b2"],
        textBlockIds: ["b2"],
      },
    ]);
    expect(text(conciliated.blocks, "b1")).toBe(
      "La infrafinanciación de las universidades públicas y la falta de PDI obliga a repartir más estudiantes.",
    );
    // The other pending passage keeps its automatic proposal.
    expect(text(conciliated.blocks, "b2")).toBe(text(voted.blocks, "b2"));
    expect(text(conciliated.blocks, "b3")).toBe(text(voted.blocks, "b3"));
  });

  it("has no blocks in the text for a passage that deletes them all", () => {
    const gone = {
      id: "D",
      ops: [{ op: "delete" as const, blockIds: ["b2"] }],
    };
    const outcome = consolidateApproved(base, [a, b, gone]);
    for (const passage of pendingPassagesOf(outcome)) {
      expect(passage.textBlockIds).not.toContain("b2");
    }
  });
});

describe("storedPendingPassages", () => {
  it("reads a final text as nothing pending", () => {
    expect(storedPendingPassages(null)).toEqual([]);
    expect(storedPendingPassages(undefined)).toEqual([]);
    expect(storedPendingPassages([])).toEqual([]);
  });
});

describe("pendingPassageStarts", () => {
  it("names the first block of each passage with its amendments", () => {
    const starts = pendingPassageStarts([
      {
        key: "k1",
        amendmentIds: ["A", "B"],
        blockIds: ["b2"],
        textBlockIds: ["b2", "n1"],
      },
      { key: "k2", amendmentIds: ["C"], blockIds: ["b5"], textBlockIds: [] },
    ]);
    expect([...starts]).toEqual([["b2", ["A", "B"]]]);
  });
});

describe("withBlockNotes", () => {
  it("opens a block with a bold note and moves its marks after it", () => {
    const block: Block = {
      id: "b2",
      type: "paragraph",
      text: "Las ratios",
      marks: [{ type: "italic", from: 4, to: 10 }],
    };
    const [noted, other] = withBlockNotes(
      [block, p("b3", "Otro")],
      new Map([["b2", "Pendiente de conciliar E3 y E5"]]),
    );
    const prefix = "[Pendiente de conciliar E3 y E5] ";
    expect(noted!.text).toBe(`${prefix}Las ratios`);
    expect(noted!.marks).toEqual([
      { type: "bold", from: 0, to: prefix.length - 1 },
      { type: "italic", from: 4 + prefix.length, to: 10 + prefix.length },
    ]);
    expect(other).toEqual(p("b3", "Otro"));
    // The original is untouched.
    expect(block.text).toBe("Las ratios");
  });

  it("leaves images and formulas alone", () => {
    const formula: Block = { id: "f", type: "formula", text: "x^2", marks: [] };
    expect(withBlockNotes([formula], new Map([["f", "Nota"]]))).toEqual([
      formula,
    ]);
  });
});

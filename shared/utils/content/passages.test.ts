import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block, ReplaceOp } from "../../types/content";
import { inApprovalOrder } from "../approvalOrder";
import { consolidate } from "./consolidate";
import { diffPassage } from "./diff";
import {
  approvalImpact,
  consolidateApproved,
  passageFragment,
  rangesTouch,
} from "./passages";

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

/** Replaces the first `find` of block `blockId` with `text`. */
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

/** Inserts `text` right after the first `after` of block `blockId`. */
function insertAfter(blockId: string, after: string, text: string): ReplaceOp {
  const block = base.find((item) => item.id === blockId)!;
  const at = block.text.indexOf(after) + after.length;
  return { op: "replace", blockId, from: at, to: at, text, baseText: "" };
}

const del = (...blockIds: string[]): AmendmentOp => ({
  op: "delete",
  blockIds,
});

const text = (blocks: Block[], id: string) =>
  blocks.find((block) => block.id === id)?.text;

// UM2 adds "de PDI " right after "contratación ", UEX6 deletes
// "y la falta de contratación ": they touch without sharing text.
const um2 = {
  id: "UM2",
  ops: [insertAfter("b1", "contratación ", "de PDI ")],
};
const uex6 = {
  id: "UEX6",
  ops: [replace("b1", "y la falta de contratación ", "")],
};

describe("rangesTouch", () => {
  it("finds a point at the edge of a range and contiguous ranges", () => {
    expect(rangesTouch({ from: 98, to: 98 }, { from: 71, to: 98 })).toBe(true);
    expect(rangesTouch({ from: 71, to: 71 }, { from: 71, to: 98 })).toBe(true);
    expect(rangesTouch({ from: 0, to: 5 }, { from: 5, to: 9 })).toBe(true);
    expect(rangesTouch({ from: 0, to: 5 }, { from: 6, to: 9 })).toBe(false);
    // Intersecting is colliding, not touching.
    expect(rangesTouch({ from: 0, to: 6 }, { from: 5, to: 9 })).toBe(false);
  });
});

describe("consolidateApproved", () => {
  it("reads as consolidate when nothing meets", () => {
    const a = { id: "A", ops: [replace("b2", "muchas", "bastantes")] };
    const b = { id: "B", ops: [replace("b3", "modelo", "enfoque")] };
    const result = consolidateApproved(base, [a, b]);
    expect(result.passages).toEqual([]);
    expect(result.superseded).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.blocks).toEqual(consolidate(base, [a, b]).blocks);
    expect(result.applied).toEqual(["A", "B"]);
  });

  it("leaves touching changes pending, both applied", () => {
    const result = consolidateApproved(base, [um2, uex6]);
    expect(result.conflicts).toEqual([]);
    expect(result.passages).toEqual([
      {
        key: "UEX6,UM2|b1",
        amendmentIds: ["UM2", "UEX6"],
        blockIds: ["b1"],
        status: "pending",
        wordingId: null,
        dropped: [],
      },
    ]);
    expect(text(result.blocks, "b1")).toBe(
      "La infrafinanciación de las universidades públicas de PDI obliga a repartir más estudiantes.",
    );
  });

  it("lets the last approved win over the same text until the Mesa words it", () => {
    const a = { id: "A", ops: [replace("b2", "muchas", "bastantes")] };
    const b = {
      id: "B",
      ops: [replace("b2", "en muchas asignaturas", "en asignaturas troncales")],
    };
    const ab = consolidateApproved(base, [a, b]);
    expect(ab.passages[0]).toMatchObject({
      amendmentIds: ["A", "B"],
      status: "pending",
      dropped: ["A"],
    });
    expect(text(ab.blocks, "b2")).toBe(
      "Las ratios se disparan en asignaturas troncales.",
    );
    const ba = consolidateApproved(base, [b, a]);
    expect(ba.passages[0]!.dropped).toEqual(["B"]);
    expect(text(ba.blocks, "b2")).toBe(
      "Las ratios se disparan en bastantes asignaturas.",
    );
  });

  it("lets a deletion win on its own, in either order, and keeps the rest", () => {
    const edits = {
      id: "E",
      ops: [
        replace("b2", "muchas", "bastantes"),
        replace("b3", "modelo", "enfoque"),
      ],
    };
    const deletes = { id: "D", ops: [del("b2")] };
    for (const order of [
      [edits, deletes],
      [deletes, edits],
    ]) {
      const result = consolidateApproved(base, order);
      expect(result.conflicts).toEqual([]);
      expect(result.superseded).toEqual([
        { amendmentId: "E", by: "D", blockIds: ["b2"] },
      ]);
      expect(result.passages).toEqual([
        expect.objectContaining({
          blockIds: ["b2"],
          status: "automatic",
          dropped: ["E"],
        }),
      ]);
      expect(text(result.blocks, "b2")).toBeUndefined();
      expect(text(result.blocks, "b3")).toBe(
        "Hace falta un enfoque centrado en el estudiantado.",
      );
    }
  });

  it("applies the Mesa's wording for exactly that passage", () => {
    const passage = [
      p(
        "b1",
        "La infrafinanciación de las universidades públicas y la falta de PDI obliga a repartir más estudiantes.",
      ),
    ];
    const ops = diffPassage([base[0]!], passage, null, () => "x");
    const wording = {
      id: "W",
      amendmentIds: ["UEX6", "UM2"],
      blockIds: ["b1"],
      ops,
    };
    const result = consolidateApproved(base, [um2, uex6], {
      wordings: [wording],
    });
    expect(result.passages[0]).toMatchObject({
      status: "worded",
      wordingId: "W",
    });
    expect(result.wordingIds).toEqual(["W"]);
    expect(result.applied).toEqual(["UM2", "UEX6"]);
    expect(text(result.blocks, "b1")).toBe(passage[0]!.text);
    expect(
      result.annotated[0]!.segments.some((segment) => segment.source === "W"),
    ).toBe(true);

    // Once the passage changes, the wording waits.
    const other = { id: "C", ops: [replace("b1", "estudiantes", "alumnado")] };
    const changed = consolidateApproved(base, [um2, uex6, other], {
      wordings: [wording],
    });
    expect(changed.passages[0]).toMatchObject({
      status: "pending",
      amendmentIds: ["UM2", "UEX6", "C"],
    });
    expect(changed.wordingIds).toEqual([]);
  });

  it("lets the Mesa correct a deletion", () => {
    const edits = { id: "E", ops: [replace("b2", "muchas", "bastantes")] };
    const deletes = { id: "D", ops: [del("b2")] };
    const kept = [p("b2", "Las ratios se disparan en bastantes asignaturas.")];
    const wording = {
      id: "W",
      amendmentIds: ["D", "E"],
      blockIds: ["b2"],
      ops: diffPassage([base[1]!], kept, "b1", () => "x"),
    };
    const result = consolidateApproved(base, [edits, deletes], {
      wordings: [wording],
    });
    expect(result.superseded).toEqual([]);
    expect(result.passages[0]!.status).toBe("worded");
    expect(text(result.blocks, "b2")).toBe(kept[0]!.text);
  });

  it("ignores a wording that changes text outside its passage", () => {
    const wording = {
      id: "W",
      amendmentIds: ["UM2", "UEX6"],
      blockIds: ["b1"],
      ops: [replace("b3", "modelo", "enfoque")],
    };
    const result = consolidateApproved(base, [um2, uex6], {
      wordings: [wording],
    });
    expect(result.passages[0]!.status).toBe("pending");
  });

  it("reports what no longer fits the base, as consolidate does", () => {
    const broken = {
      id: "X",
      ops: [{ ...replace("b2", "muchas", "bastantes"), baseText: "otras" }],
    };
    const result = consolidateApproved(base, [broken]);
    expect(result.conflicts).toEqual([{ amendmentId: "X", conflictsWith: [] }]);
    expect(result.applied).toEqual([]);
  });
});

describe("approvalImpact", () => {
  it("says what approving an amendment does to the approved text", () => {
    const impact = approvalImpact(base, [um2], uex6);
    expect(impact?.others).toEqual(["UM2"]);
    expect(impact?.passage.status).toBe("pending");
    expect(impact?.now.map((block) => block.id)).toEqual(["b1"]);
    expect(impact?.after.map((block) => block.id)).toEqual(["b1"]);
    expect(approvalImpact(base, [], uex6)).toBeNull();

    const deletion = approvalImpact(
      base,
      [{ id: "E", ops: [replace("b2", "muchas", "bastantes")] }],
      { id: "D", ops: [del("b2")] },
    );
    expect(deletion?.supersedes).toEqual(["E"]);
    expect(deletion?.passage.status).toBe("automatic");
  });

  it("takes the passage's fragment with what was inserted after it", () => {
    const insert = {
      id: "I",
      ops: [
        {
          op: "insert" as const,
          afterBlockId: "b2",
          blocks: [p("n1", "Nuevo párrafo.")],
        },
      ],
    };
    const result = consolidateApproved(base, [insert]);
    expect(
      passageFragment(result.annotated, ["b2"]).map((block) => block.id),
    ).toEqual(["b2", "n1"]);
  });
});

describe("inApprovalOrder", () => {
  it("sorts by decision time, then number, then id, undecided last", () => {
    const list = [
      { id: "c", decidedAt: null, number: 1 },
      { id: "b", decidedAt: "2026-11-19T10:00:00Z", number: 2 },
      { id: "a", decidedAt: "2026-11-19T10:00:00Z", number: 1 },
      { id: "d", decidedAt: new Date("2026-11-19T09:00:00Z"), number: 9 },
    ];
    expect(inApprovalOrder(list).map((item) => item.id)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });
});

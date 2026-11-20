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

  it("takes over what is inserted after the passage, never twice", () => {
    const a = {
      id: "A",
      ops: [
        replace("b2", "muchas", "bastantes"),
        {
          op: "insert" as const,
          afterBlockId: "b2",
          blocks: [p("n1", "Nuevo párrafo de A.")],
        },
      ],
    };
    const b = {
      id: "B",
      ops: [replace("b2", "en muchas asignaturas", "en las troncales")],
    };
    const other = {
      id: "C",
      ops: [
        {
          op: "insert" as const,
          afterBlockId: "b2",
          blocks: [p("n2", "Nuevo párrafo de C.")],
        },
      ],
    };
    const now = consolidateApproved(base, [a, b, other]);
    const passage = now.passages[0]!;
    expect(passage.amendmentIds).toEqual(["A", "B", "C"]);
    // Worded exactly as it reads, the text stays the same.
    const shown = passageFragment(now.annotated, passage.blockIds)
      .filter((block) => block.status !== "deleted")
      .map((block) => now.blocks.find((item) => item.id === block.id)!);
    const ops = diffPassage([base[1]!], shown, "b1", () => "x");
    const worded = consolidateApproved(base, [a, b, other], {
      wordings: [
        {
          id: "W",
          amendmentIds: passage.amendmentIds,
          blockIds: passage.blockIds,
          ops,
        },
      ],
    });
    expect(worded.passages[0]!.status).toBe("worded");
    expect(worded.blocks.map((block) => block.text)).toEqual(
      now.blocks.map((block) => block.text),
    );
    const ids = worded.blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("makes a passage one run of blocks", () => {
    const a = {
      id: "A",
      ops: [replace("b1", "públicas", "estatales"), del("b3")],
    };
    const b = {
      id: "B",
      ops: [
        replace("b1", "públicas y", "públicas, y"),
        replace("b3", "modelo", "enfoque"),
      ],
    };
    const c = { id: "C", ops: [replace("b2", "muchas", "bastantes")] };
    const result = consolidateApproved(base, [a, b, c]);
    expect(result.passages).toEqual([
      expect.objectContaining({
        amendmentIds: ["A", "B", "C"],
        blockIds: ["b1", "b2", "b3"],
      }),
    ]);
  });

  it("never makes a passage of an insert after a deleted block", () => {
    const deletes = { id: "D", ops: [del("b2")] };
    const inserts = {
      id: "I",
      ops: [
        {
          op: "insert" as const,
          afterBlockId: "b2",
          blocks: [p("n1", "Nuevo párrafo.")],
        },
      ],
    };
    expect(consolidateApproved(base, [deletes, inserts]).passages).toEqual([]);
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

// Merging word by word (user's decision of 2026-11-20), on the cases of the
// 80.ª AGO the Mesa had to word by hand.
describe("consolidateApproved merges word by word", () => {
  const block = (id: string, text: string): Block => p(id, text);
  /** Replaces the first `find` of `source` (a block) with `text`. */
  const change = (
    source: Block,
    find: string,
    text: string,
    from = source.text.indexOf(find),
  ): ReplaceOp => {
    if (from < 0) throw new Error(`"${find}" is not in ${source.id}`);
    return {
      op: "replace",
      blockId: source.id,
      from,
      to: from + find.length,
      text,
      baseText: find,
    };
  };
  const at = (source: Block, after: string, text: string): ReplaceOp => {
    const point = source.text.indexOf(after) + after.length;
    return {
      op: "replace",
      blockId: source.id,
      from: point,
      to: point,
      text,
      baseText: "",
    };
  };

  it("takes an expansion of a word a rewrite around it keeps", () => {
    const m = block(
      "m",
      "Basadas en los informes que los órganos responsables creados por el SIGC y en entrevistas.",
    );
    const um5 = {
      id: "UM5",
      ops: [
        change(m, "que", "de"),
        change(m, "creados por el SIGC y", "en el marco del SIGC, así como"),
      ],
    };
    const uclm5 = {
      id: "UCLM5",
      ops: [change(m, "SIGC", "Sistema Interno de Garantía de Calidad (SIGC)")],
    };
    for (const order of [
      [um5, uclm5],
      [uclm5, um5],
    ]) {
      const result = consolidateApproved([m], order);
      expect(result.passages[0]).toMatchObject({
        status: "merged",
        dropped: [],
      });
      expect(text(result.blocks, "m")).toBe(
        "Basadas en los informes de los órganos responsables en el marco del Sistema Interno de Garantía de Calidad (SIGC), así como en entrevistas.",
      );
    }
  });

  it("counts the same change made twice once", () => {
    const m = block("m", "Atención en la reconocimiento de créditos.");
    const result = consolidateApproved(
      [m],
      [
        { id: "US1", ops: [change(m, "la", "el")] },
        { id: "UCLM2", ops: [change(m, "la", "el")] },
      ],
    );
    expect(result.passages[0]).toMatchObject({ status: "merged" });
    expect(text(result.blocks, "m")).toBe(
      "Atención en el reconocimiento de créditos.",
    );
  });

  it("leaves without effect a comma or a few words inside a sentence another rewrites", () => {
    const m = block(
      "m",
      "Fija el marco. Estipula en su apartado segundo que para obtener una evaluación positiva basta con cumplir.",
    );
    const um3 = {
      id: "UM3",
      ops: [
        change(
          m,
          ". Estipula en su apartado segundo que para obtener una evaluación positiva basta con cumplir",
          ", que fijó un marco de mínimos",
        ),
      ],
    };
    const us1 = {
      id: "US1",
      ops: [at(m, "segundo que", ","), at(m, "evaluación positiva", ",")],
    };
    const result = consolidateApproved([m], [um3, us1]);
    expect(result.passages[0]).toMatchObject({
      status: "merged",
      dropped: ["US1"],
    });
    expect(result.superseded).toEqual([
      { amendmentId: "US1", by: "UM3", blockIds: ["m"] },
    ]);
    expect(text(result.blocks, "m")).toBe(
      "Fija el marco, que fijó un marco de mínimos.",
    );

    const words = block(
      "w",
      "Preocupa el uso de los títulos a la que parece apuntar la actuación.",
    );
    const t3 = {
      id: "T3",
      ops: [
        change(
          words,
          "uso de los títulos a la que parece apuntar",
          "alcance que se plantea en",
        ),
      ],
    };
    const us5 = { id: "US5", ops: [change(words, "a la", "al")] };
    expect(text(consolidateApproved([words], [us5, t3]).blocks, "w")).toBe(
      "Preocupa el alcance que se plantea en la actuación.",
    );
  });

  it("counts a space a rewrite next to it already adds once", () => {
    const m = block("m", "Un uso real del 49 %.El hecho es claro.");
    const result = consolidateApproved(
      [m],
      [
        {
          id: "UM2",
          ops: [change(m, "Un uso real del 49 %.", "Un uso del 49,2 %. ")],
        },
        { id: "US3", ops: [at(m, "49 %.", " ")] },
      ],
    );
    expect(result.passages[0]).toMatchObject({ status: "merged" });
    expect(text(result.blocks, "m")).toBe(
      "Un uso del 49,2 %. El hecho es claro.",
    );
  });

  it("leaves to the Mesa an expansion of words a rewrite takes away", () => {
    const m = block(
      "m",
      "Según los datos de la CRUE recogidos en el Posicionamiento, la universidad pública sufre y la sociedad lo nota.",
    );
    const um2 = {
      id: "UM2",
      ops: [
        change(
          m,
          "Según los datos de la CRUE recogidos en el Posicionamiento, la universidad pública sufre y la sociedad lo nota.",
          "La comunicación es un pilar de la universidad y la sociedad.",
        ),
      ],
    };
    const uclm1 = {
      id: "UCLM1",
      ops: [
        change(
          m,
          "CRUE",
          "Conferencia de Rectores y Rectoras de las Universidades Españolas (CRUE)",
        ),
      ],
    };
    const result = consolidateApproved([m], [um2, uclm1]);
    expect(result.passages[0]).toMatchObject({ status: "pending" });
  });

  it("leaves to the Mesa a rename inside a list a rewrite moves", () => {
    const m = block(
      "m",
      "Los Estatutos, que establecen la condición de lengua propia y su oficialidad en los respectivos territorios. Así sucede en Catalunya, la Comunitat Valenciana y Galicia.",
    );
    const t4 = {
      id: "T4",
      ops: [
        change(
          m,
          ", que establecen la condición de lengua propia y su oficialidad en los respectivos territorios. Así sucede en Catalunya, la Comunitat Valenciana y Galicia",
          " (en Catalunya, la Comunitat Valenciana y Galiza) y la Ley Foral, que establecen la condición de lengua propia y su oficialidad en los respectivos territorios",
        ),
      ],
    };
    const uv1 = {
      id: "UV1",
      ops: [change(m, "la Comunitat Valenciana", "el País Valencià")],
    };
    expect(consolidateApproved([m], [uv1, t4]).passages[0]).toMatchObject({
      status: "pending",
    });
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

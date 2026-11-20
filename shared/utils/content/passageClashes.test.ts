import { describe, expect, it } from "vitest";
import type { Block, ReplaceOp } from "../../types/content";
import {
  amendmentPassageOps,
  passageClashes,
  passageCoverage,
} from "./passageClashes";

const text = "La comunicación es un pilar esencial de la universidad pública.";
const base: Block[] = [
  { id: "b1", type: "paragraph", text, marks: [] },
  { id: "b2", type: "paragraph", text: "Segundo párrafo.", marks: [] },
];

function replace(from: number, to: number, value: string): ReplaceOp {
  return {
    op: "replace",
    blockId: "b1",
    from,
    to,
    text: value,
    baseText: text.slice(from, to),
  };
}

describe("passageClashes", () => {
  it("joins the touching changes of two amendments into one stretch", () => {
    // "es un pilar esencial" (16-36) and "pilar esencial de la" (22-42).
    const clashes = passageClashes(
      base,
      [
        { id: "A", ops: [replace(16, 36, "es la base")] },
        { id: "B", ops: [replace(22, 42, "fundamento de toda la")] },
      ],
      ["b1"],
    );
    expect(clashes).toHaveLength(1);
    const [clash] = clashes;
    expect(clash!.base.text).toBe("es un pilar esencial de la");
    expect(clash!.proposals.map((p) => p.amendmentId)).toEqual(["A", "B"]);
    // Each proposal is an operation over the stretch alone.
    expect(clash!.proposals[0]!.ops[0]).toMatchObject({
      blockId: clash!.key,
      from: 0,
      to: 20,
      text: "es la base",
    });
    expect(clash!.proposals[1]!.ops[0]).toMatchObject({ from: 6, to: 26 });
  });

  it("leaves out changes only one amendment makes", () => {
    const clashes = passageClashes(
      base,
      [
        { id: "A", ops: [replace(0, 2, "Toda la")] },
        { id: "B", ops: [replace(50, 63, "privada.")] },
      ],
      ["b1"],
    );
    expect(clashes).toEqual([]);
  });

  it("takes the whole block when one amendment deletes it", () => {
    const clashes = passageClashes(
      base,
      [
        { id: "A", ops: [{ op: "delete", blockIds: ["b1"] }] },
        { id: "B", ops: [replace(16, 36, "es la base")] },
      ],
      ["b1"],
    );
    expect(clashes[0]!.base.text).toBe(text);
    expect(clashes[0]!.proposals[0]).toMatchObject({
      amendmentId: "A",
      deletes: true,
      ops: [],
    });
  });

  it("keeps only the operations on the passage", () => {
    const ops = amendmentPassageOps(
      {
        id: "A",
        ops: [
          replace(0, 2, "Toda la"),
          { ...replace(0, 7, "Tercer"), blockId: "b9" },
        ],
      },
      ["b1"],
    );
    expect(ops).toHaveLength(1);
  });
});

describe("passageCoverage", () => {
  const before = "la universidad pública es un pilar esencial";
  const amended = "la universidad pública es el fundamento de la sociedad";

  it("says whether a wording keeps all, part or none of an amendment", () => {
    expect(passageCoverage(before, amended, amended)).toBe("all");
    expect(passageCoverage(before, amended, before)).toBe("none");
    expect(
      passageCoverage(
        before,
        amended,
        "la universidad pública es el fundamento esencial",
      ),
    ).toBe("part");
  });

  it("counts a rewrite that moves common words as all of it", () => {
    const rewrite =
      "es en la universidad donde la sociedad deja de ser lo que era";
    expect(passageCoverage(before, rewrite, rewrite)).toBe("all");
    expect(passageCoverage(before, rewrite, `${rewrite} `)).toBe("all");
  });
});

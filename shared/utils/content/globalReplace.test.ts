import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "../../types/content";
import { globalReplaceExcerpt } from "./globalReplace";
import { globalReplaceOps } from "./ops";

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

/** Paragraphs that name the Comisión (the third twice), and one that does not. */
const base: Block[] = [
  p("p1", "La Comisión decide."),
  p("p2", "Sin cambios."),
  p("p3", "La Comisión propone y la Comisión vota."),
  p("p4", "La Comisión informa."),
  p("p5", "La Comisión cierra."),
  p("p6", "La Comisión se disuelve."),
];
const ops = globalReplaceOps(base, "Comisión", "Junta");

const blocksOf = (shown: AmendmentOp[]) => [
  ...new Set(shown.map((op) => (op.op === "replace" ? op.blockId : ""))),
];

describe("globalReplaceExcerpt", () => {
  it("keeps every occurrence of the first paragraphs and counts the rest", () => {
    expect(ops).toHaveLength(6);
    const excerpt = globalReplaceExcerpt(base, ops, 2);
    expect(blocksOf(excerpt.ops)).toEqual(["p1", "p3"]);
    // Both occurrences of p3, never one of them alone.
    expect(excerpt.ops).toHaveLength(3);
    expect(excerpt.more).toBe(3);
  });

  it("orders by the text, whatever order the operations come in", () => {
    const excerpt = globalReplaceExcerpt(base, [...ops].reverse(), 1);
    expect(blocksOf(excerpt.ops)).toEqual(["p1"]);
    expect(excerpt.more).toBe(5);
  });

  it("shows everything without a limit, without the base or when it fits", () => {
    expect(globalReplaceExcerpt(base, ops)).toEqual({ ops, more: 0 });
    expect(globalReplaceExcerpt(null, ops, 1)).toEqual({ ops, more: 0 });
    expect(globalReplaceExcerpt(base, ops, 5)).toEqual({ ops, more: 0 });
    expect(globalReplaceExcerpt(base, [], 3)).toEqual({ ops: [], more: 0 });
  });
});

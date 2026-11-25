import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { previewAmendment } from "../../../shared/utils/content/consolidate";
import { LinkRegistry, MUTED_GREY, annotatedToPdf } from "./content";

// The PDF of an amendment's fragment says where it leaves text out, as the
// screen does (MOT-4): «[…]», in grey, on a line of its own between runs.

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});
const li = (id: string, text: string): Block => ({
  id,
  type: "list_item",
  level: 0,
  list: "ordered",
  marker: "a)",
  text,
  marks: [],
});

function at(blocks: Block[], blockId: string, text: string): AmendmentOp {
  const block = blocks.find((candidate) => candidate.id === blockId)!;
  return {
    op: "replace",
    blockId,
    from: 0,
    to: block.text.length,
    text,
    baseText: block.text,
  };
}

/** Every text leaf of the PDF content, in order, with its colour. */
function leaves(content: unknown): { text: string; color?: unknown }[] {
  const found: { text: string; color?: unknown }[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") {
      found.push({ text: record.text, color: record.color });
    }
    Object.values(record).forEach(walk);
  };
  walk(content);
  return found;
}

/** The PDF's numbered items' counters, in the order they show. */
function counters(content: unknown): number[] {
  const found: number[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.counter === "number") found.push(record.counter);
    Object.values(record).forEach(walk);
  };
  walk(content);
  return found;
}

const pdfOf = (blocks: ReturnType<typeof previewAmendment>) =>
  annotatedToPdf(blocks, { links: new LinkRegistry(), codeOf: () => "A" });

const text: Block[] = [
  p("p1", "Uno."),
  p("p2", "Dos."),
  p("p3", "Tres."),
  p("p4", "Cuatro."),
  p("p5", "Cinco."),
];

describe("gaps in a fragment's PDF", () => {
  it("prints «[…]» in grey between two runs", () => {
    const fragment = previewAmendment(text, {
      id: "A",
      ops: [at(text, "p1", "UNO."), at(text, "p5", "CINCO.")],
    });
    const shown = leaves(pdfOf(fragment));
    const gaps = shown.filter((leaf) => leaf.text === "[…]");
    expect(gaps).toEqual([{ text: "[…]", color: MUTED_GREY }]);
    const texts = shown.map((leaf) => leaf.text);
    const gap = texts.indexOf("[…]");
    expect(gap).toBeGreaterThan(texts.indexOf("UNO."));
    expect(gap).toBeLessThan(texts.indexOf("CINCO."));
  });

  it("prints nothing in a single run", () => {
    const fragment = previewAmendment(text, {
      id: "A",
      ops: [at(text, "p2", "DOS."), at(text, "p3", "TRES.")],
    });
    const texts = leaves(pdfOf(fragment)).map((leaf) => leaf.text);
    expect(texts).not.toContain("[…]");
  });

  it("numbers the list after the gap as it reads in the whole", () => {
    const list: Block[] = "abcdefgh"
      .split("")
      .map((letter) => li(`l${letter}`, `${letter}.`));
    const fragment = previewAmendment(list, {
      id: "A",
      ops: [at(list, "lb", "B."), at(list, "lg", "G.")],
    });
    const content = pdfOf(fragment);
    expect(leaves(content).map((leaf) => leaf.text)).toContain("[…]");
    expect(counters(content)).toEqual([2, 7]);
  });

  it("prints one «[…]» between two rows of one table", () => {
    const cell = (id: string, row: string): Block => ({
      ...p(id, `Fila ${row}.`),
      cell: { table: "t1", row, cell: `c${row}` },
    });
    const table = [cell("r1", "1"), cell("r2", "2"), cell("r3", "3")];
    const fragment = previewAmendment(table, {
      id: "A",
      ops: [at(table, "r1", "FILA 1."), at(table, "r3", "FILA 3.")],
    });
    const texts = leaves(pdfOf(fragment)).map((leaf) => leaf.text);
    expect(texts.filter((text) => text === "[…]")).toHaveLength(1);
  });
});

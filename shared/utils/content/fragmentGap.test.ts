import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "../../types/content";
import { previewAmendment, type FragmentBlock } from "./consolidate";
import { renderAnnotated, renderBlocks } from "./render";

/**
 * A fragment that leaves text out says so (MOT-4): the first block of each
 * run after the first carries `gapBefore`, and the render puts «[…]» there.
 */

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
const cell = (id: string, row: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
  cell: { table: "t1", row, cell: `c${row}` },
});

const text: Block[] = [
  p("p1", "Uno."),
  p("p2", "Dos."),
  p("p3", "Tres."),
  p("p4", "Cuatro."),
  p("p5", "Cinco."),
  p("p6", "Seis."),
];

function at(
  blocks: Block[],
  blockId: string,
  replacement: string,
): AmendmentOp {
  const block = blocks.find((candidate) => candidate.id === blockId)!;
  return {
    op: "replace",
    blockId,
    from: 0,
    to: block.text.length,
    text: replacement,
    baseText: block.text,
  };
}

const gaps = (fragment: FragmentBlock[]) =>
  fragment.filter((block) => block.gapBefore).map((block) => block.id);

const GAP_LABELLED =
  '<p class="cx-gap text-muted"><span aria-hidden="true">[…]</span><span class="sr-only">Texto omitido</span></p>';

describe("gaps in a fragment", () => {
  it("marks the first block of every run after the first", () => {
    const fragment = previewAmendment(text, {
      id: "A",
      ops: [
        at(text, "p1", "UNO."),
        at(text, "p3", "TRES."),
        at(text, "p6", "SEIS."),
      ],
    });
    expect(fragment.map((block) => block.id)).toEqual(["p1", "p3", "p6"]);
    expect(gaps(fragment)).toEqual(["p3", "p6"]);
  });

  it("marks nothing in a single run, nor where context joins two", () => {
    const one = previewAmendment(text, {
      id: "A",
      ops: [at(text, "p2", "DOS."), at(text, "p3", "TRES.")],
    });
    expect(gaps(one)).toEqual([]);
    // p2 and p4, one block of context each: p1 to p5, one run.
    const joined = previewAmendment(
      text,
      { id: "A", ops: [at(text, "p2", "DOS."), at(text, "p4", "CUATRO.")] },
      1,
    );
    expect(joined.map((block) => block.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
    expect(gaps(joined)).toEqual([]);
  });

  it("draws «[…]» between runs, said in words when labelled", () => {
    const fragment = previewAmendment(text, {
      id: "A",
      ops: [at(text, "p1", "UNO."), at(text, "p5", "CINCO.")],
    });
    const html = renderAnnotated(fragment, {
      mode: "diff",
      omitted: "Texto omitido",
    });
    const gap = html.indexOf(GAP_LABELLED);
    expect(gap).toBeGreaterThan(html.indexOf('data-block-id="p1"'));
    expect(gap).toBeLessThan(html.indexOf('data-block-id="p5"'));
    expect(html.split("cx-gap")).toHaveLength(2);
    // No label: the marks alone, read as they are.
    const bare = renderAnnotated(fragment, { mode: "diff" });
    expect(bare).toContain('<p class="cx-gap text-muted">[…]</p>');
    expect(bare).not.toContain("aria-hidden");
  });

  it("closes the list before the gap and reopens it at its number", () => {
    const list: Block[] = "abcdefgh".split("").map((l) => li(`l${l}`, `${l}.`));
    const fragment = previewAmendment(list, {
      id: "A",
      ops: [at(list, "lb", "B."), at(list, "lg", "G.")],
    });
    const html = renderAnnotated(fragment, { mode: "diff", omitted: "x" });
    expect(html).toMatch(
      /<\/li><\/ol><p class="cx-gap text-muted">.*?<\/p><ol data-marker="a\)" start="7"><li data-block-id="lg"/,
    );
  });

  it("is no block: it carries no block id", () => {
    const fragment = previewAmendment(text, {
      id: "A",
      ops: [at(text, "p1", "UNO."), at(text, "p6", "SEIS.")],
    });
    const html = renderAnnotated(fragment, { mode: "diff", omitted: "x" });
    expect(html).not.toMatch(/<p[^>]*data-block-id[^>]*cx-gap/);
    expect(html).not.toMatch(/cx-gap[^>]*data-block-id/);
  });

  it("moves to the next shown block when its own is not shown", () => {
    const fragment = previewAmendment(text, {
      id: "A",
      ops: [
        at(text, "p1", "UNO."),
        { op: "delete", blockIds: ["p4"] },
        at(text, "p5", "CINCO."),
      ],
    });
    expect(gaps(fragment)).toEqual(["p4"]);
    const clean = renderAnnotated(fragment, { mode: "clean", omitted: "x" });
    expect(clean).not.toContain('data-block-id="p4"');
    expect(clean.indexOf("cx-gap")).toBeGreaterThan(
      clean.indexOf('data-block-id="p1"'),
    );
    expect(clean.indexOf("cx-gap")).toBeLessThan(
      clean.indexOf('data-block-id="p5"'),
    );
    // Nothing shown before it: nothing is said to be left out.
    const tail = renderAnnotated(
      previewAmendment(text, {
        id: "A",
        ops: [{ op: "delete", blockIds: ["p1"] }, at(text, "p4", "CUATRO.")],
      }),
      { mode: "clean", omitted: "x" },
    );
    expect(tail).not.toContain("cx-gap");
  });

  it("goes before a table that opens a run, outside it", () => {
    const withTable: Block[] = [
      p("p1", "Uno."),
      p("p2", "Dos."),
      cell("r1", "row1", "Fila uno."),
      cell("r2", "row2", "Fila dos."),
    ];
    const fragment = previewAmendment(withTable, {
      id: "A",
      ops: [at(withTable, "p1", "UNO."), at(withTable, "r1", "FILA UNO.")],
    });
    const html = renderAnnotated(fragment, { mode: "diff", omitted: "x" });
    expect(html).toMatch(
      /<\/p><p class="cx-gap[^"]*">.*?<\/p><div class="cx-table-wrap">/,
    );
    expect(html.split("cx-gap")).toHaveLength(2);
  });

  it("leaves whole texts as they were", () => {
    expect(renderBlocks(text)).not.toContain("cx-gap");
  });
});

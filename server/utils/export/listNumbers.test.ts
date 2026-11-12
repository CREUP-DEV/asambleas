import { describe, expect, it } from "vitest";
import type {
  AmendmentOp,
  Block,
  ConsolidatedBlock,
  ListMarker,
} from "../../../shared/types/content";
import { consolidate } from "../../../shared/utils/content/consolidate";
import { orderedListNumbers } from "../../../shared/utils/content/lists";
import { LinkRegistry, annotatedToPdf } from "./content";

// The PDF of an amendment's diff numbers its ordered items as the HTML diff
// does (orderedListNumbers with deleted items left out): a struck item takes
// no number and hands on a start it carries, another marker or a table cell
// starts a list of its own.

const counted = (block: ConsolidatedBlock) => block.status !== "deleted";

/** The counters of the PDF's numbered items, in the order they show. */
function pdfCounters(content: unknown): number[] {
  const counters: number[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.counter === "number") counters.push(record.counter);
    Object.values(record).forEach(walk);
  };
  walk(content);
  return counters;
}

/** orderedListNumbers' numbers, in block order. */
function htmlNumbers(annotated: ConsolidatedBlock[]): number[] {
  const numbers = orderedListNumbers(annotated, counted);
  return annotated.flatMap((block) => {
    const n = numbers.get(block.id);
    return n === undefined ? [] : [n];
  });
}

function pdfOf(annotated: ConsolidatedBlock[]): unknown {
  return annotatedToPdf(annotated, {
    links: new LinkRegistry(),
    codeOf: () => "CEUM 1",
  });
}

const li = (id: string, extra: Partial<Block> = {}): Block => ({
  id,
  type: "list_item",
  level: 0,
  list: "ordered",
  marker: "a)",
  text: `Apartado ${id}.`,
  marks: [],
  ...extra,
});
const p = (id: string): Block => ({
  id,
  type: "paragraph",
  text: `Párrafo ${id}.`,
  marks: [],
});
const deleting = (base: Block[], ids: string[]) =>
  consolidate(base, [{ id: "A", ops: [{ op: "delete", blockIds: ids }] }])
    .annotated;

describe("PDF list numbers of an annotated diff", () => {
  const cases: [string, ConsolidatedBlock[], number[]][] = [
    [
      "a struck item in the middle of a list",
      deleting([li("a"), li("b"), li("c"), li("d")], ["b"]),
      [1, 2, 3],
    ],
    [
      "a struck item with another marker",
      deleting([li("a"), li("b"), li("x", { marker: "1." }), li("c")], ["x"]),
      [1, 2, 1],
    ],
    [
      "a struck item that opens a list",
      deleting([p("p0"), li("a"), li("b"), li("c")], ["a"]),
      [1, 2],
    ],
    [
      "a struck item that carries the list's start",
      deleting([p("p0"), li("k", { start: 11 }), li("l"), li("m")], ["k"]),
      [11, 12],
    ],
    [
      "a struck item that starts its list again",
      deleting([li("a"), li("b"), li("x", { start: 1 }), li("y")], ["x"]),
      [1, 2, 1],
    ],
    [
      "a struck nested item",
      deleting(
        [
          li("a"),
          li("a1", { level: 1, marker: "1." }),
          li("a2", { level: 1, marker: "1." }),
          li("b"),
        ],
        ["a1"],
      ),
      [1, 1, 2],
    ],
    [
      "items in a table cell, apart from the list around it",
      deleting(
        [
          li("a"),
          li("t1", { cell: { table: "t", row: "r1", cell: "c1" } }),
          li("t2", { cell: { table: "t", row: "r1", cell: "c1" } }),
          li("t3", { cell: { table: "t", row: "r1", cell: "c1" } }),
          li("u1", { cell: { table: "t", row: "r1", cell: "c2" } }),
          li("b"),
        ],
        ["t1"],
      ),
      [1, 1, 2, 1, 1],
    ],
  ];

  it.each(cases)("%s", (_, annotated, expected) => {
    expect(htmlNumbers(annotated)).toEqual(expected);
    expect(pdfCounters(pdfOf(annotated))).toEqual(expected);
  });

  it("matches orderedListNumbers on random diffs", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)]!;
    const markers: ListMarker[] = ["1.", "a)", "i."];

    for (let round = 0; round < 300; round++) {
      const base: Block[] = [];
      let level = 0;
      const size = 3 + Math.floor(random() * 12);
      for (let i = 0; i < size; i++) {
        const id = `r${round}b${i}`;
        if (random() < 0.2) {
          base.push(p(id));
          level = 0;
          continue;
        }
        level = Math.max(0, Math.min(level + pick([-1, 0, 0, 0, 1]), 2));
        base.push(
          li(id, {
            level,
            list: random() < 0.85 ? "ordered" : "bullet",
            marker: random() < 0.75 ? "a)" : pick(markers),
            ...(random() < 0.15
              ? { start: 1 + Math.floor(random() * 20) }
              : {}),
          }),
        );
      }
      const deleted = base
        .filter(() => random() < 0.3)
        .map((block) => block.id);
      const anchor = pick(base);
      const ops: AmendmentOp[] = [
        ...(deleted.length > 0
          ? [{ op: "delete" as const, blockIds: deleted }]
          : []),
        ...(random() < 0.5
          ? [
              {
                op: "insert" as const,
                afterBlockId: anchor.id,
                blocks: [li(`r${round}new`, { level: anchor.level ?? 0 })],
              },
            ]
          : []),
      ];
      const { annotated } = consolidate(base, [{ id: "A", ops }]);
      expect(pdfCounters(pdfOf(annotated)), `round ${round}`).toEqual(
        htmlNumbers(annotated),
      );
    }
  });
});

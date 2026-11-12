import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { blocksToEditor, editorToBlocks } from "~~/shared/utils/content/editor";
import { validateOps } from "~~/shared/utils/content/ops";
import { sessionTransactionalSeed } from "./sessionModel";

// The Mesa's transactional composer seeds a passage with its real list
// numbers, as the members' one does (transactionalComposerSeed).

let counter = 0;
const newId = () => `new${(counter += 1).toString().padStart(4, "0")}`;

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const li = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  type: "list_item",
  level: 0,
  list: "ordered",
  marker: "a)",
  text,
  marks: [],
  ...extra,
});

// Art. 15.1: a) to m), with "1.º" and "2.º" under c).
const article: Block[] = [
  p("intro", "Son funciones de la Asamblea:"),
  ..."abcdefghijklm"
    .split("")
    .flatMap((letter) => [
      li(`l${letter}`, `Apartado ${letter}.`),
      ...(letter === "c"
        ? [
            li("c1", "Primero.", { level: 1, marker: "1." }),
            li("c2", "Segundo.", { level: 1, marker: "1." }),
          ]
        : []),
    ]),
];

const at = (
  blocks: Block[],
  blockId: string,
  from: number,
  to: number,
  text: string,
): AmendmentOp => {
  const block = blocks.find((candidate) => candidate.id === blockId)!;
  return {
    op: "replace",
    blockId,
    from,
    to,
    text,
    baseText: block.text.slice(from, to),
  };
};

// The editor reads the seed as the Mesa finds it.
const throughEditor = (blocks: Block[]) =>
  editorToBlocks(blocksToEditor(blocks), newId);
const formatOps = (ops: AmendmentOp[]) =>
  ops.filter((op) => op.op === "replace" && op.block !== undefined);

describe("session transactional seed: list numbers", () => {
  it("returns no blocks before an empty passage", () => {
    expect(sessionTransactionalSeed(article, [], newId)).toEqual({
      passage: [],
      anchorBefore: null,
      before: [],
      seed: [],
      skipped: [],
    });
  });

  it("starts the passage at its real letter", () => {
    const seed = sessionTransactionalSeed(
      article,
      [{ id: "s", ops: [at(article, "lk", 9, 10, "k bis")] }],
      newId,
    );
    expect(seed.before.map((block) => block.id)).toEqual(
      article
        .slice(
          0,
          article.findIndex((block) => block.id === "lk"),
        )
        .map((block) => block.id),
    );
    expect(seed.seed.map((block) => [block.id, block.start])).toEqual([
      ["lk", 11],
    ]);
    // Untouched in the editor, the numbers are no change of format.
    const edited = throughEditor(seed.seed);
    const ops = diffPassage(
      seed.passage,
      edited,
      seed.anchorBefore,
      newId,
      seed.before,
    );
    expect(formatOps(ops)).toEqual([]);
    expect(validateOps(article, ops)).toEqual([]);
  });

  it("reads no change when the Mesa deletes the item that starts it", () => {
    const seed = sessionTransactionalSeed(
      article,
      [
        {
          id: "s",
          ops: [
            at(article, "lk", 9, 10, "k bis"),
            at(article, "ll", 9, 10, "l bis"),
          ],
        },
      ],
      newId,
    );
    const doc = blocksToEditor(seed.seed);
    doc.content![0]!.content!.shift();
    const edited = editorToBlocks(doc, newId);
    expect(edited.map((block) => [block.id, block.start])).toEqual([
      ["ll", 11],
    ]);
    const ops = diffPassage(
      seed.passage,
      edited,
      seed.anchorBefore,
      newId,
      seed.before,
    );
    expect(formatOps(ops)).toEqual([]);
    expect(ops.some((op) => op.op === "delete")).toBe(true);
  });

  it("reads no change on a passage that starts inside a nested list", () => {
    const seed = sessionTransactionalSeed(
      article,
      [{ id: "s", ops: [at(article, "c2", 0, 7, "Otro")] }],
      newId,
    );
    expect(seed.seed.map((block) => block.start)).toEqual([2]);
    const ops = diffPassage(
      seed.passage,
      throughEditor(seed.seed),
      seed.anchorBefore,
      newId,
      seed.before,
    );
    expect(formatOps(ops)).toEqual([]);
  });

  it("keeps a start the Mesa changes", () => {
    const seed = sessionTransactionalSeed(
      article,
      [{ id: "s", ops: [at(article, "lk", 9, 10, "k bis")] }],
      newId,
    );
    const edited = throughEditor(seed.seed).map((block) => ({
      ...block,
      start: 20,
    }));
    const ops = diffPassage(
      seed.passage,
      edited,
      seed.anchorBefore,
      newId,
      seed.before,
    );
    expect(formatOps(ops)).toMatchObject([
      { blockId: "lk", block: { start: 20 } },
    ]);
  });

  it("reads no change when the deleted first item stores the start", () => {
    // A list that carries on after a paragraph: "k)" stores its start.
    const carried: Block[] = [
      li("lj", "Apartado j."),
      p("mid", "Intermedio."),
      li("lk", "Apartado k.", { start: 11 }),
      li("ll", "Apartado l."),
    ];
    const seed = sessionTransactionalSeed(
      carried,
      [
        {
          id: "s",
          ops: [
            at(carried, "lk", 9, 10, "k bis"),
            at(carried, "ll", 9, 10, "l bis"),
          ],
        },
      ],
      newId,
    );
    const doc = blocksToEditor(seed.seed);
    doc.content![0]!.content!.shift();
    const ops = diffPassage(
      seed.passage,
      editorToBlocks(doc, newId),
      seed.anchorBefore,
      newId,
      seed.before,
    );
    expect(formatOps(ops)).toEqual([]);
    expect(ops).toContainEqual({ op: "delete", blockIds: ["lk"] });
  });
});

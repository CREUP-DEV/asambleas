import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block, ReplaceOp } from "../../types/content";
import { diffPassage } from "./diff";
import { blocksToEditor, editorToBlocks } from "./editor";
import { validateOps } from "./ops";
import {
  sameBlockContent,
  sameIdSet,
  transactionalSeed,
} from "./transactionalSeed";

// The one seed of a transactional, for the members' composer
// (transactionalComposerSeed) and the Mesa's (sessionTransactionalSeed).

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

// The editor reads the seed as the author finds it.
const throughEditor = (blocks: Block[]) =>
  editorToBlocks(blocksToEditor(blocks), newId);
const formatOps = (ops: AmendmentOp[]) =>
  ops.filter((op) => op.op === "replace" && op.block !== undefined);

describe("transactional seed: list numbers", () => {
  it("returns no blocks before an empty passage", () => {
    expect(transactionalSeed(article, [], newId)).toEqual({
      passage: [],
      anchorBefore: null,
      before: [],
      seed: [],
      skipped: [],
    });
  });

  it("starts the passage at its real letter", () => {
    const seed = transactionalSeed(
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

  it("reads no change when the author deletes the item that starts it", () => {
    const seed = transactionalSeed(
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
    const seed = transactionalSeed(
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

  it("keeps a start the author changes", () => {
    const seed = transactionalSeed(
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
    const seed = transactionalSeed(
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

/** Replaces the first `find` of `block` with `text`. */
const change = (block: Block, find: string, text: string): ReplaceOp => {
  const from = block.text.indexOf(find);
  if (from < 0) throw new Error(`"${find}" is not in ${block.id}`);
  return {
    op: "replace",
    blockId: block.id,
    from,
    to: from + find.length,
    text,
    baseText: find,
  };
};

describe("transactional seed: sources together", () => {
  const m = p(
    "m",
    "Basadas en los informes que los órganos responsables creados por el SIGC y en entrevistas.",
  );
  const tail = p("t", "Fin del texto.");
  const text = [m, tail];

  it("merges word by word what the approved text merges (MOT-16)", () => {
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
      const seed = transactionalSeed(text, order, newId);
      expect(seed.skipped).toEqual([]);
      expect(seed.seed.map((block) => block.text)).toEqual([
        "Basadas en los informes de los órganos responsables en el marco del Sistema Interno de Garantía de Calidad (SIGC), así como en entrevistas.",
      ]);
      const ops = diffPassage(
        seed.passage,
        seed.seed,
        seed.anchorBefore,
        newId,
        seed.before,
      );
      expect(validateOps(text, ops)).toEqual([]);
    }
  });

  it("counts the same change twice once", () => {
    const one = { id: "one", ops: [change(m, "SIGC", "sistema")] };
    const two = { id: "two", ops: [change(m, "SIGC", "sistema")] };
    const seed = transactionalSeed(text, [one, two], newId);
    expect(seed.skipped).toEqual([]);
    expect(seed.seed[0]!.text).toContain("por el sistema y");
  });

  it("keeps the first that fits and skips a colliding source whole", () => {
    const first = { id: "first", ops: [change(m, "SIGC", "sistema")] };
    const clash = {
      id: "clash",
      ops: [change(m, "SIGC", "comité"), change(tail, "Fin", "Final")],
    };
    const seed = transactionalSeed(text, [first, clash], newId);
    expect(seed.skipped).toEqual(["clash"]);
    expect(seed.seed.map((block) => block.text)).toEqual([
      "Basadas en los informes que los órganos responsables creados por el sistema y en entrevistas.",
      "Fin del texto.",
    ]);
  });

  it("lets the first of a deletion and a change of the same block win", () => {
    const edit = { id: "edit", ops: [change(tail, "Fin", "Final")] };
    const drop = {
      id: "drop",
      ops: [{ op: "delete" as const, blockIds: ["t"] }],
    };
    const changed = transactionalSeed(text, [edit, drop], newId);
    expect(changed.skipped).toEqual(["drop"]);
    expect(changed.seed.map((block) => block.text)).toEqual([
      "Final del texto.",
    ]);
    const deleted = transactionalSeed(text, [drop, edit], newId);
    expect(deleted.skipped).toEqual(["edit"]);
    expect(deleted.passage.map((block) => block.id)).toEqual(["t"]);
    expect(deleted.seed).toEqual([]);
  });

  it("takes a block deleted twice as one deletion", () => {
    const drop = (id: string, blockIds: string[]) => ({
      id,
      ops: [{ op: "delete" as const, blockIds }],
    });
    const twice = transactionalSeed(
      text,
      [drop("one", ["t"]), drop("two", ["t"])],
      newId,
    );
    expect(twice.skipped).toEqual([]);
    expect(twice.seed).toEqual([]);
    const wider = transactionalSeed(
      text,
      [drop("one", ["t"]), drop("two", ["m", "t"])],
      newId,
    );
    expect(wider.skipped).toEqual([]);
    expect(wider.passage.map((block) => block.id)).toEqual(["m", "t"]);
    expect(wider.seed).toEqual([]);
  });

  it("skips an invalid source", () => {
    const stale = {
      id: "stale",
      ops: [{ ...change(tail, "Fin", "Final"), baseText: "Otro" }],
    };
    const seed = transactionalSeed(text, [stale], newId);
    expect(seed.skipped).toEqual(["stale"]);
    expect(seed.seed.map((block) => block.text)).toEqual(["Fin del texto."]);
  });

  it("gives every block marks of its own", () => {
    const bold = { type: "bold" as const, from: 0, to: 3 };
    const inserted = p("own", "Nuevo.");
    inserted.marks = [bold];
    const seed = transactionalSeed(
      text,
      [
        {
          id: "ins",
          ops: [{ op: "insert", afterBlockId: "t", blocks: [inserted] }],
        },
      ],
      newId,
    );
    const block = seed.seed.at(-1)!;
    expect(block.id).not.toBe("own");
    expect(block.marks).toEqual([bold]);
    expect(block.marks[0]).not.toBe(bold);
  });
});

describe("transactional draft comparisons", () => {
  const base = [p("b1", "Uno."), p("b2", "Dos."), p("b3", "Tres.")];

  it("compares source sets in any order and ignoring repeats", () => {
    expect(sameIdSet(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });

  it("compares text and formatting, never ids", () => {
    const renamed = base.map((block, i) => ({ ...block, id: `n${i}` }));
    expect(sameBlockContent(base, renamed)).toBe(true);
    expect(
      sameBlockContent(base, [
        base[0]!,
        { ...base[1]!, text: "Otro." },
        base[2]!,
      ]),
    ).toBe(false);
    expect(sameBlockContent(base, base.slice(0, 2))).toBe(false);
    expect(
      sameBlockContent(
        [base[0]!],
        [{ ...base[0]!, marks: [{ type: "bold", from: 0, to: 2 }] }],
      ),
    ).toBe(false);
  });

  it("reads a cell's old shade as the fill the editor returns", () => {
    const cell = (extra: Partial<NonNullable<Block["cell"]>>): Block => ({
      ...p("c", "Celda."),
      cell: { table: "t", row: "r", cell: "c", ...extra },
    });
    expect(
      sameBlockContent([cell({ shade: true })], [cell({ fill: "beige" })]),
    ).toBe(true);
    expect(
      sameBlockContent([cell({ colspan: 1 })], [cell({ colspan: 2 })]),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block } from "../../types/content";
import { consolidate, mapPosition, previewAmendment } from "./consolidate";
import { diffPassage, diffText } from "./diff";
import { blocksSchema } from "../schemas/content";
import { blocksToEditor, editorToBlocks } from "./editor";
import { formatListNumber, orderedListNumbers } from "./lists";
import { groupTables, tableGrid, type TableGroup } from "./tables";
import { changeKinds, globalReplaceOps, positionKey, validateOps } from "./ops";
import { findOverlaps, overlapBetween } from "./overlaps";
import { renderAnnotated, renderBlocks } from "./render";

let counter = 0;
const newId = () => `new${String(counter++).padStart(4, "0")}`;

const p = (id: string, text: string, marks: Block["marks"] = []): Block => ({
  id,
  type: "paragraph",
  text,
  marks,
});

const base: Block[] = [
  {
    id: "h001",
    type: "heading",
    level: 1,
    text: "3. Devolución de la beca",
    marks: [],
  },
  p(
    "b001",
    "El alumnado deberá reintegrar la ayuda en su totalidad cuando no supere el 50 % de los créditos.",
  ),
  p("b002", "Las universidades habilitarán un procedimiento de alegaciones."),
  p("b003", "Disposición final."),
];

function apply(
  text: string,
  ops: { from: number; to: number; text: string }[],
) {
  return [...ops]
    .sort((a, b) => b.from - a.from)
    .reduce(
      (acc, op) => acc.slice(0, op.from) + op.text + acc.slice(op.to),
      text,
    );
}

describe("diffText", () => {
  it("produces a word-level modification merged across whitespace", () => {
    const ops = diffText(
      base[1]!,
      base[1]!.text.replace("en su totalidad", "de forma proporcional"),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      baseText: "en su totalidad",
      text: "de forma proporcional",
    });
  });

  it("round-trips arbitrary edits", () => {
    const edited =
      "El alumnado podrá reintegrar parte de la ayuda cuando no supere el 40 % de los créditos matriculados.";
    const ops = diffText(base[1]!, edited);
    expect(validateOps(base, ops)).toEqual([]);
    expect(apply(base[1]!.text, ops)).toBe(edited);
  });

  it("returns nothing when the text is unchanged", () => {
    expect(diffText(base[1]!, base[1]!.text)).toEqual([]);
  });

  it("does not strike and re-add a repeated phrase", () => {
    const block = p(
      "c001",
      "Por todo lo anterior, CREUP insta al Ministerio de Ciencia, Innovación y Universidades y a las comunidades autónomas a abordar de forma urgente una reforma del sistema de becas y ayudas al estudio que garantice la equidad, la suficiencia y la previsibilidad.",
    );
    const edited = block.text.replace(
      " y a las comunidades autónomas",
      ", a las comunidades autónomas y a las universidades públicas",
    );
    const ops = diffText(block, edited);
    const comma = block.text.indexOf(" y a las comunidades");
    const end = block.text.indexOf(" a abordar");
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      from: comma,
      to: comma + 2,
      baseText: " y",
      text: ",",
    });
    expect(ops[1]).toMatchObject({
      from: end,
      to: end,
      baseText: "",
      text: " y a las universidades públicas",
    });
    expect(validateOps([block], ops)).toEqual([]);
    expect(apply(block.text, ops)).toBe(edited);
  });
});

describe("diffPassage", () => {
  it("detects edits, deletions and insertions in a passage", () => {
    const passage = [base[1]!, base[2]!];
    const edited = [
      p("b001", base[1]!.text.replace("50 %", "40 %")),
      p("fresh01", "Nuevo párrafo añadido."),
    ];
    const ops = diffPassage(passage, edited, "h001", newId);
    expect(validateOps(base, ops)).toEqual([]);
    expect(ops.find((op) => op.op === "delete")).toEqual({
      op: "delete",
      blockIds: ["b002"],
    });
    expect(ops.find((op) => op.op === "insert")).toMatchObject({
      afterBlockId: "b001",
    });
    expect(changeKinds(ops)).toEqual([
      "suppression",
      "addition",
      "modification",
    ]);
  });

  it("anchors insertions before the first block to the previous base block", () => {
    const ops = diffPassage(
      [base[1]!],
      [p("fresh02", "Antes."), base[1]!],
      "h001",
      newId,
    );
    expect(ops).toEqual([
      { op: "insert", afterBlockId: "h001", blocks: [p("fresh02", "Antes.")] },
    ]);
  });

  it("treats a moved block as delete plus insert", () => {
    const ops = diffPassage(
      [base[1]!, base[2]!],
      [base[2]!, base[1]!],
      "h001",
      newId,
    );
    expect(validateOps(base, ops)).toEqual([]);
    const result = consolidate(base, [{ id: "a", ops }]);
    expect(result.blocks.map((b) => b.text)).toEqual([
      base[0]!.text,
      base[2]!.text,
      base[1]!.text,
      base[3]!.text,
    ]);
  });
});

describe("validateOps", () => {
  it("rejects anchors that do not match the base", () => {
    const ops: AmendmentOp[] = [
      {
        op: "replace",
        blockId: "b001",
        from: 0,
        to: 2,
        text: "Un",
        baseText: "Xx",
      },
    ];
    expect(validateOps(base, ops).map((e) => e.reason)).toContain(
      "anchor_mismatch",
    );
  });

  it("rejects overlapping ops and edits inside deleted blocks", () => {
    const ops: AmendmentOp[] = [
      {
        op: "replace",
        blockId: "b002",
        from: 0,
        to: 3,
        text: "Unas",
        baseText: "Las",
      },
      {
        op: "replace",
        blockId: "b002",
        from: 2,
        to: 5,
        text: "x",
        baseText: "s u",
      },
      { op: "delete", blockIds: ["b002"] },
    ];
    const reasons = validateOps(base, ops).map((e) => e.reason);
    expect(reasons).toContain("overlapping_ops");
    expect(reasons).toContain("replace_in_deleted_block");
  });
});

describe("overlaps", () => {
  const replace = (
    blockId: string,
    from: number,
    to: number,
    text = "x",
  ): AmendmentOp => {
    const block = base.find((b) => b.id === blockId)!;
    return {
      op: "replace",
      blockId,
      from,
      to,
      text,
      baseText: block.text.slice(from, to),
    };
  };

  it("does not flag edits to different sentences of the same paragraph", () => {
    expect(
      overlapBetween([replace("b001", 0, 11)], [replace("b001", 40, 55)]),
    ).toBeNull();
  });

  it("flags intersecting ranges, removed blocks and shared anchors", () => {
    expect(
      overlapBetween([replace("b001", 0, 20)], [replace("b001", 10, 30)]),
    ).toBe("same_text");
    expect(
      overlapBetween(
        [replace("b002", 0, 3)],
        [{ op: "delete", blockIds: ["b002"] }],
      ),
    ).toBe("removed_block");
    expect(
      overlapBetween(
        [{ op: "insert", afterBlockId: "b002", blocks: [p("n1aa", "a")] }],
        [{ op: "insert", afterBlockId: "b002", blocks: [p("n2aa", "b")] }],
      ),
    ).toBe("same_position");
  });

  it("clusters chains of overlapping amendments", () => {
    const report = findOverlaps([
      { id: "A", ops: [replace("b001", 0, 20)] },
      { id: "B", ops: [replace("b001", 15, 40)] },
      { id: "C", ops: [replace("b001", 35, 50)] },
      { id: "D", ops: [replace("b003", 0, 5)] },
    ]);
    expect(report.clusters).toEqual([["A", "B", "C"]]);
    expect(report.pairs).toHaveLength(2);
  });

  it("orders amendments by position in the text", () => {
    expect(positionKey([replace("b002", 0, 3)], base)).toBeGreaterThan(
      positionKey([replace("b001", 50, 52)], base),
    );
  });
});

describe("consolidate", () => {
  it("applies non-conflicting amendments with provenance", () => {
    const a = {
      id: "A",
      ops: diffText(
        base[1]!,
        base[1]!.text.replace("en su totalidad", "de forma proporcional"),
      ),
    };
    const b = {
      id: "B",
      ops: diffText(base[1]!, base[1]!.text.replace("50 %", "40 %")),
    };
    const result = consolidate(base, [a, b]);
    expect(result.conflicts).toEqual([]);
    expect(result.blocks[1]!.text).toBe(
      "El alumnado deberá reintegrar la ayuda de forma proporcional cuando no supere el 40 % de los créditos.",
    );
    const sources = result.annotated[1]!.segments.filter((s) => s.source).map(
      (s) => s.source,
    );
    expect(new Set(sources)).toEqual(new Set(["A", "B"]));
  });

  it("skips an amendment that collides with one already applied", () => {
    const a = {
      id: "A",
      ops: diffText(base[1]!, base[1]!.text.replace("50 %", "40 %")),
    };
    const b = {
      id: "B",
      ops: diffText(base[1]!, base[1]!.text.replace("50 %", "60 %")),
    };
    const result = consolidate(base, [a, b]);
    expect(result.applied).toEqual(["A"]);
    expect(result.conflicts).toEqual([
      { amendmentId: "B", conflictsWith: ["A"] },
    ]);
  });

  it("keeps insertions after the same anchor in approval order", () => {
    const a = {
      id: "A",
      ops: [
        {
          op: "insert",
          afterBlockId: "b002",
          blocks: [p("ins1aaa", "Primero.")],
        },
      ] as AmendmentOp[],
    };
    const b = {
      id: "B",
      ops: [
        {
          op: "insert",
          afterBlockId: "b002",
          blocks: [p("ins2aaa", "Segundo.")],
        },
      ] as AmendmentOp[],
    };
    const result = consolidate(base, [b, a]);
    expect(result.blocks.map((x) => x.text).slice(3, 5)).toEqual([
      "Segundo.",
      "Primero.",
    ]);
  });

  it("maps marks around replaced text", () => {
    const marked: Block[] = [
      p("m001", "uno dos tres", [{ type: "bold", from: 4, to: 7 }]),
    ];
    const ops = diffText(marked[0]!, "uno cinco dos tres");
    const result = consolidate(marked, [{ id: "A", ops }]);
    const block = result.blocks[0]!;
    expect(block.text).toBe("uno cinco dos tres");
    expect(block.text.slice(block.marks[0]!.from, block.marks[0]!.to)).toBe(
      "dos",
    );
  });

  it("maps positions through insertions and replacements", () => {
    const ops = [
      { from: 2, to: 2, text: "XX" },
      { from: 5, to: 8, text: "Y" },
    ];
    expect(mapPosition(2, ops, -1)).toBe(2);
    expect(mapPosition(2, ops, 1)).toBe(4);
    expect(mapPosition(6, ops, -1)).toBe(7);
    expect(mapPosition(10, ops, 1)).toBe(10);
  });

  it("previews only the touched blocks", () => {
    const ops = diffText(
      base[2]!,
      "Las universidades habilitarán un procedimiento ágil de alegaciones.",
    );
    const preview = previewAmendment(base, { id: "A", ops });
    expect(preview.map((b) => b.id)).toEqual(["b002"]);
  });
});

describe("globalReplaceOps", () => {
  it("replaces whole words only", () => {
    const blocks = [
      p("g001", "centros adscritos y centrosx"),
      p("g002", "Los centros."),
    ];
    const ops = globalReplaceOps(blocks, "centros", "centros públicos");
    expect(ops).toHaveLength(2);
    expect(validateOps(blocks, ops)).toEqual([]);
  });
});

describe("render", () => {
  it("escapes text and drops unsafe links", () => {
    const html = renderBlocks([
      p("r001", "<script>x</script> & enlace", [
        { type: "link", from: 21, to: 27, href: "javascript:alert(1)" },
        { type: "bold", from: 0, to: 8 },
      ]),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<strong>&lt;script&gt;</strong>");
  });

  it("renders nested lists", () => {
    const html = renderBlocks([
      {
        id: "l001",
        type: "list_item",
        list: "bullet",
        level: 0,
        text: "a",
        marks: [],
      },
      {
        id: "l002",
        type: "list_item",
        list: "bullet",
        level: 1,
        text: "b",
        marks: [],
      },
      {
        id: "l003",
        type: "list_item",
        list: "bullet",
        level: 0,
        text: "c",
        marks: [],
      },
      p("l004", "fin"),
    ]);
    expect(html).toBe(
      '<ul><li data-block-id="l001">a<ul><li data-block-id="l002">b</li></ul></li><li data-block-id="l003">c</li></ul><p data-block-id="l004">fin</p>',
    );
  });

  it("renders diffs with ins and del", () => {
    const ops = diffText(
      base[2]!,
      "Las universidades crearán un procedimiento de alegaciones.",
    );
    const { annotated } = consolidate(base, [{ id: "A", ops }]);
    const html = renderAnnotated([annotated[2]!], { mode: "diff" });
    expect(html).toContain(
      '<del class="cx-del" data-amendment-id="A">habilitarán</del>',
    );
    expect(html).toContain(
      '<ins class="cx-ins" data-amendment-id="A">crearán</ins>',
    );
  });

  it("reads diff labels before insertions and removals", () => {
    const ops = diffText(
      base[2]!,
      "Las universidades crearán un procedimiento de alegaciones.",
    );
    const { annotated } = consolidate(base, [{ id: "A", ops }]);
    const html = renderAnnotated([annotated[2]!], {
      mode: "diff",
      diffLabels: { inserted: "Se añade:", removed: "<Se quita:>" },
    });
    expect(html).toContain(
      '<del class="cx-del" data-amendment-id="A"><span class="sr-only">&lt;Se quita:&gt; </span>habilitarán</del>',
    );
    expect(html).toContain(
      '<ins class="cx-ins" data-amendment-id="A"><span class="sr-only">Se añade: </span>crearán</ins>',
    );
  });

  it("renders headings as styled paragraphs when asked", () => {
    expect(renderBlocks([base[0]!], { headings: false })).toBe(
      '<p data-block-id="h001" class="cx-heading cx-heading-2">3. Devolución de la beca</p>',
    );
    expect(renderBlocks([base[0]!])).toBe(
      '<h2 data-block-id="h001">3. Devolución de la beca</h2>',
    );

    const heading: Block = {
      id: "h002",
      type: "heading",
      level: 2,
      text: "4. Plazos",
      marks: [],
    };
    const { annotated } = consolidate(base, [
      {
        id: "A",
        ops: [{ op: "insert", afterBlockId: "b001", blocks: [heading] }],
      },
    ]);
    const inserted = annotated.find((block) => block.id === "h002")!;
    const html = renderAnnotated([inserted], { mode: "diff", headings: false });
    expect(html).toBe(
      '<p data-block-id="h002" data-amendment-id="A" class="cx-heading cx-heading-3 cx-block-inserted"><ins class="cx-ins" data-amendment-id="A">4. Plazos</ins></p>',
    );
    expect(renderAnnotated([inserted], { mode: "diff" })).toBe(
      '<h3 data-block-id="h002" data-amendment-id="A" class="cx-block-inserted"><ins class="cx-ins" data-amendment-id="A">4. Plazos</ins></h3>',
    );
  });
});

describe("editor conversion", () => {
  it("round-trips blocks through the editor JSON", () => {
    const blocks: Block[] = [
      { id: "e001", type: "heading", level: 2, text: "Título", marks: [] },
      p("e002", "Texto con negrita", [{ type: "bold", from: 10, to: 17 }]),
      {
        id: "e003",
        type: "list_item",
        list: "ordered",
        level: 0,
        text: "uno",
        marks: [],
      },
      {
        id: "e004",
        type: "list_item",
        list: "ordered",
        level: 1,
        text: "uno.uno",
        marks: [],
      },
      { id: "e005", type: "quote", text: "cita", marks: [] },
    ];
    expect(editorToBlocks(blocksToEditor(blocks), newId)).toEqual(blocks);
  });
});

describe("ordered list markers", () => {
  const item = (
    id: string,
    text: string,
    extra: Partial<Block> = {},
  ): Block => ({
    id,
    type: "list_item",
    level: 0,
    list: "ordered",
    text,
    marks: [],
    ...extra,
  });
  // "a)", "b)", an interruption, then "c)" and a nested "i.".
  const lettered: Block[] = [
    item("o001", "Primero", { marker: "a)" }),
    item("o002", "Segundo", { marker: "a)" }),
    p("o003", "Párrafo intermedio."),
    item("o004", "Tercero", { marker: "a)", start: 3 }),
    item("o005", "Detalle", { marker: "i.", level: 1 }),
    item("o006", "Cuarto", { marker: "a)" }),
  ];

  it("formats numbers as Word does", () => {
    expect(formatListNumber(3, "a)")).toBe("c)");
    expect(formatListNumber(28, "a.")).toBe("bb.");
    expect(formatListNumber(4, "I.")).toBe("IV.");
    expect(formatListNumber(9, "i)")).toBe("ix)");
    expect(formatListNumber(12, "1.")).toBe("12.");
  });

  it("numbers items the way every renderer groups them", () => {
    const numbers = orderedListNumbers(lettered);
    expect([...numbers.entries()]).toEqual([
      ["o001", 1],
      ["o002", 2],
      ["o004", 3],
      ["o005", 1],
      ["o006", 4],
    ]);
    // A different marker or an explicit start begins a new list.
    const mixed = orderedListNumbers([
      item("x1", "uno"),
      item("x2", "a", { marker: "a)" }),
      item("x3", "otra vez", { start: 1 }),
      item("x4", "dos"),
    ]);
    expect([...mixed.values()]).toEqual([1, 1, 1, 2]);
  });

  it("keeps markers and starts only on ordered items", () => {
    const parsed = blocksSchema.parse([
      item("s001", "a", { marker: "a)", start: 3 }),
      item("s002", "b", { marker: "1." }),
      { ...item("s003", "c", { marker: "I.", start: 2 }), list: "bullet" },
    ]);
    expect(parsed.map((block) => [block.marker, block.start])).toEqual([
      ["a)", 3],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(() =>
      blocksSchema.parse([{ ...item("s004", "d"), marker: "ii)" }]),
    ).toThrow();
  });

  it("renders the marker and starts a list again where an item says so", () => {
    const html = renderBlocks(lettered);
    expect(html.match(/<ol[^>]*>/g)).toEqual([
      '<ol data-marker="a)">',
      '<ol data-marker="a)" start="3">',
      '<ol data-marker="i.">',
    ]);
  });

  it("survives a round trip through the editor", () => {
    const doc = blocksToEditor(lettered);
    const lists = doc.content!.filter((node) => node.type === "orderedList");
    expect(lists.map((node) => node.attrs)).toEqual([
      { start: 1, marker: "a)" },
      { start: 3, marker: "a)" },
    ]);
    expect(editorToBlocks(doc, newId)).toEqual(lettered);

    // Two lists side by side, the second from 1 again, stay two.
    const twice = [
      item("t001", "uno"),
      item("t002", "uno otra vez", { start: 1 }),
    ];
    expect(editorToBlocks(blocksToEditor(twice), newId)).toEqual(twice);
  });

  it("carries markers and starts through consolidation", () => {
    const { blocks } = consolidate(lettered, []);
    expect(blocks).toEqual(lettered);
  });
});

describe("tables", () => {
  const at = (
    row: string,
    cell: string,
    extra: Partial<Block["cell"]> = {},
  ): Block["cell"] => ({ table: "tab1", row, cell, ...extra });
  const c = (
    id: string,
    text: string,
    cell: Block["cell"],
    extra: Partial<Block> = {},
  ): Block => ({ id, type: "paragraph", text, marks: [], cell, ...extra });
  const table: Block[] = [
    p("t000", "Antes."),
    c("t001", "Órgano", at("row1", "cel1", { header: true })),
    c("t002", "Fecha", at("row1", "cel2", { header: true })),
    c("t003", "Secretaría", at("row2", "cel3")),
    c("t004", "", at("row2", "cel4")),
    c("t005", "Nota a toda la fila", at("row3", "cel5", { colspan: 2 })),
    {
      id: "t006",
      type: "list_item",
      level: 0,
      list: "bullet",
      text: "detalle",
      marks: [],
      cell: at("row3", "cel5", { colspan: 2 }),
    },
    p("t007", "Después."),
  ];

  it("groups blocks into tables, rows and cells", () => {
    const runs = groupTables(table);
    expect(runs.map((run) => run.kind)).toEqual(["blocks", "table", "blocks"]);
    const grid = tableGrid(
      (runs[1] as Extract<(typeof runs)[number], { kind: "table" }>).table,
    );
    expect(grid.columns).toBe(2);
    expect(grid.headerRows).toBe(1);
    expect(
      grid.rows.map((row) => row.map((cell) => [cell.column, cell.colspan])),
    ).toEqual([
      [
        [0, 1],
        [1, 1],
      ],
      [
        [0, 1],
        [1, 1],
      ],
      [[0, 2]],
    ]);
  });

  it("lays rowspans out like a browser", () => {
    const grid = tableGrid(
      (
        groupTables([
          c("r001", "alto", at("a", "x", { rowspan: 2 })),
          c("r002", "1", at("a", "y")),
          c("r003", "2", at("b", "z")),
        ])[0] as { kind: "table"; table: TableGroup<Block> }
      ).table,
    );
    expect(grid.rows[1]![0]!.column).toBe(1);
  });

  it("renders a table with headers, spans and lists in cells", () => {
    const html = renderBlocks(table);
    expect(html).toContain(
      '<div class="cx-table-wrap"><table class="cx-table">',
    );
    expect(html).toContain("<th><p");
    expect(html).toContain('<td colspan="2"><p');
    expect(html).toMatch(
      /<td colspan="2"><p[^>]*>Nota a toda la fila<\/p><ul>/,
    );
    // A blank cell keeps its place.
    expect(html).toContain("<td><p");
  });

  it("validates cell references", () => {
    const parsed = blocksSchema.parse(table);
    expect(parsed[5]!.cell).toEqual(at("row3", "cel5", { colspan: 2 }));
    expect(() =>
      blocksSchema.parse([c("v001", "x", at("bad id!", "cel1"))]),
    ).toThrow();
  });

  it("survives a round trip through the editor", () => {
    const doc = blocksToEditor(table);
    expect(doc.content!.map((node) => node.type)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ]);
    const tableNode = doc.content![1]!;
    expect(tableNode.content![0]!.content![0]!.type).toBe("tableHeader");
    expect(tableNode.content![2]!.content![0]!.attrs).toMatchObject({
      cellId: "cel5",
      colspan: 2,
    });
    expect(editorToBlocks(doc, newId)).toEqual(table);
  });

  it("gives copies of a cell their own id, and blank cells a paragraph", () => {
    const doc = blocksToEditor(table);
    const row = doc.content![1]!.content![1]!;
    // Splitting a cell copies its attributes, id included.
    row.content![1] = {
      ...row.content![1]!,
      attrs: { ...row.content![1]!.attrs, cellId: "cel3" },
      content: [],
    };
    const blocks = editorToBlocks(doc, newId);
    const cells = blocks.filter((block) => block.cell?.row === "row2");
    expect(cells.map((block) => block.text)).toEqual(["Secretaría", ""]);
    expect(cells[0]!.cell!.cell).toBe("cel3");
    expect(cells[1]!.cell!.cell).not.toBe("cel3");
  });

  it("keeps blank cells of a row an amendment adds", () => {
    const passage = table.slice(1, 7);
    const edited = [
      ...passage,
      c("n001", "Nueva", at("row4", "cel6")),
      c("n002", "", at("row4", "cel7")),
    ];
    const ops = diffPassage(passage, edited, "t000", newId);
    expect(ops).toEqual([
      { op: "insert", afterBlockId: "t006", blocks: edited.slice(6) },
    ]);
    const { blocks } = consolidate(table, [{ id: "a1", ops }]);
    expect(blocks.filter((block) => block.cell?.row === "row4")).toHaveLength(
      2,
    );
  });
});

describe("alignment", () => {
  const aligned: Block[] = [
    { ...p("a001", "Última actualización: 10 abr 2026"), align: "right" },
    {
      id: "a002",
      type: "heading",
      level: 1,
      text: "Firma",
      marks: [],
      align: "center",
    },
    p("a003", "Sin alinear."),
  ];

  it("keeps centred and right alignment only", () => {
    const parsed = blocksSchema.parse(aligned);
    expect(parsed.map((block) => block.align)).toEqual([
      "right",
      "center",
      undefined,
    ]);
    expect(() =>
      blocksSchema.parse([{ ...p("a004", "x"), align: "justify" }]),
    ).toThrow();
  });

  it("renders the alignment as a class", () => {
    const html = renderBlocks(aligned);
    expect(html).toContain('class="cx-align-right">Última actualización');
    expect(html).toMatch(/<h2 [^>]*class="cx-align-center">Firma<\/h2>/);
  });

  it("survives a round trip through the editor, left as the default", () => {
    const doc = blocksToEditor(aligned);
    expect(doc.content!.map((node) => node.attrs?.textAlign ?? null)).toEqual([
      "right",
      "center",
      null,
    ]);
    expect(editorToBlocks(doc, newId)).toEqual(aligned);
    // TipTap writes "left" when someone aligns back to the start.
    doc.content![0]!.attrs!.textAlign = "left";
    expect(editorToBlocks(doc, newId)[0]!.align).toBeUndefined();
  });

  it("carries the alignment through consolidation", () => {
    expect(consolidate(aligned, []).blocks).toEqual(aligned);
  });
});

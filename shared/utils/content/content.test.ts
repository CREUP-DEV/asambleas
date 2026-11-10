import { describe, expect, it } from "vitest";
import type { AmendmentOp, Block, FormatChange } from "../../types/content";
import { consolidate, mapPosition, previewAmendment } from "./consolidate";
import { diffPassage, diffText } from "./diff";
import { amendmentOpsSchema, blocksSchema } from "../schemas/content";
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

  it("counts a header row with a blank corner when told what is blank", () => {
    const corner = groupTables([
      c("h001", "", at("row1", "cel1")),
      c("h002", "2025", at("row1", "cel2", { header: true })),
      c("h003", "Activo", at("row2", "cel3", { header: true })),
      c("h004", "10", at("row2", "cel4")),
    ]);
    const group = (
      corner[0] as Extract<(typeof corner)[number], { kind: "table" }>
    ).table;
    expect(tableGrid(group).headerRows).toBe(0);
    const blank = (block: Block) => !block.text.trim();
    // The second row is no header: it holds a figure.
    expect(tableGrid(group, blank).headerRows).toBe(1);
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

  it("keeps shaded cells through the schema, the editor and the view", () => {
    const shaded = [
      c("s001", "Concepto", at("srow1", "scel1", { header: true })),
      c("s002", "Ingresos", at("srow2", "scel2", { shade: true })),
      c("s003", "10", at("srow2", "scel3")),
    ];
    // A header has its own fill: shading one means nothing.
    const parsed = blocksSchema.parse([
      ...shaded,
      c("s004", "x", at("srow3", "scel4", { header: true, shade: true })),
    ]);
    expect(parsed.map((block) => block.cell!.shade ?? false)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    const doc = blocksToEditor(shaded);
    const cells = doc.content![0]!.content!.flatMap((row) => row.content!);
    expect(cells.map((cell) => cell.attrs!.shade)).toEqual([
      false,
      true,
      false,
    ]);
    expect(editorToBlocks(doc, newId)).toEqual(shaded);
    expect(renderBlocks(shaded)).toMatch(
      /<td class="cx-shade"><p[^>]*>Ingresos<\/p><\/td><td><p/,
    );
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

describe("format changes", () => {
  const BOLD = "en su totalidad";
  const boldFrom = base[1]!.text.indexOf(BOLD);
  const bolded: Block = {
    ...base[1]!,
    marks: [{ type: "bold", from: boldFrom, to: boldFrom + BOLD.length }],
  };
  const labels = {
    inserted: "Se añade:",
    removed: "Se quita:",
    formatted: "Cambia el formato:",
    format: (change: FormatChange) =>
      change.value === undefined
        ? change.code
        : `${change.code} ${change.value}`,
  };
  const listBase: Block[] = [
    p("l000", "Antes de la lista."),
    { ...p("l001", "Primero"), type: "list_item", level: 0, list: "bullet" },
    { ...p("l002", "Segundo"), type: "list_item", level: 1, list: "bullet" },
    { ...p("l003", "Tercero"), type: "list_item", level: 0, list: "bullet" },
  ];

  it("turns new bold on kept text into one operation that keeps the text", () => {
    const ops = diffPassage([base[1]!], [bolded], "h001", newId);
    expect(ops).toEqual([
      {
        op: "replace",
        blockId: "b001",
        from: boldFrom,
        to: boldFrom + BOLD.length,
        text: BOLD,
        baseText: BOLD,
        marks: [{ type: "bold", from: 0, to: BOLD.length }],
      },
    ]);
    expect(validateOps(base, ops)).toEqual([]);
    expect(changeKinds(ops)).toEqual(["modification"]);
    const { blocks, annotated } = consolidate(base, [{ id: "A", ops }]);
    expect(blocks[1]).toEqual(bolded);
    expect(annotated[1]!.segments).toEqual([
      { text: base[1]!.text.slice(0, boldFrom), source: null },
      { text: BOLD, source: "A", format: [{ code: "bold_on" }] },
      { text: base[1]!.text.slice(boldFrom + BOLD.length), source: null },
    ]);
  });

  it("says which marks a text loses and when a link changes", () => {
    const marked: Block = {
      ...base[3]!,
      marks: [
        { type: "italic", from: 0, to: 11 },
        { type: "link", from: 0, to: 11, href: "https://creup.es/a" },
      ],
    };
    const edited: Block = {
      ...marked,
      marks: [{ type: "link", from: 0, to: 11, href: "https://creup.es/b" }],
    };
    const ops = diffPassage([marked], [edited], null, newId);
    expect(validateOps([marked], ops)).toEqual([]);
    const { blocks, annotated } = consolidate([marked], [{ id: "A", ops }]);
    expect(blocks[0]).toEqual(edited);
    expect(annotated[0]!.segments[0]!.format).toEqual([
      { code: "italic_off" },
      { code: "link_changed" },
    ]);
  });

  it("carries a change of text and a change of format together", () => {
    const text = base[1]!.text.replace("deberá", "tendrá que");
    const at = text.indexOf("tendrá que");
    const end = text.indexOf(BOLD) + BOLD.length;
    const edited: Block = {
      ...base[1]!,
      text,
      marks: [
        { type: "italic", from: at, to: at + 10 },
        { type: "bold", from: text.indexOf(BOLD), to: end },
      ],
    };
    const ops = diffPassage([base[1]!], [edited], "h001", newId);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      baseText: "deberá",
      text: "tendrá que",
      marks: [{ type: "italic", from: 0, to: 10 }],
    });
    expect(ops[1]).toMatchObject({ baseText: BOLD, text: BOLD });
    expect(validateOps(base, ops)).toEqual([]);
    const { blocks, annotated } = consolidate(base, [{ id: "A", ops }]);
    expect(blocks[1]).toEqual(edited);
    // The new text is struck and written again; only the kept text is
    // labelled as a change of format.
    expect(
      annotated[1]!.segments.filter((segment) => segment.source === "A"),
    ).toEqual([
      { text: "deberá", source: "A", removed: true },
      { text: "tendrá que", source: "A" },
      { text: BOLD, source: "A", format: [{ code: "bold_on" }] },
    ]);
  });

  it("leaves text edits without new formatting as they always were", () => {
    const marked: Block = {
      ...base[1]!,
      marks: [{ type: "bold", from: 3, to: 30 }],
    };
    const text = marked.text.replace("deberá", "tendrá que");
    const edited: Block = {
      ...marked,
      text,
      marks: [{ type: "bold", from: 3, to: 34 }],
    };
    const ops = diffPassage([marked], [edited], null, newId);
    expect(ops).toEqual(diffText(marked, text));
    expect(ops.every((op) => !("marks" in op) && !("block" in op))).toBe(true);
    const result = consolidate([marked], [{ id: "A", ops }]);
    // The marks come out as they were mapped: same objects, same order.
    expect(result.blocks[0]!.marks).toEqual([
      { type: "bold", from: 3, to: 34 },
    ]);
    expect(result.annotated[0]!.format).toBeUndefined();
  });

  it("turns a paragraph into a heading with one operation on the block", () => {
    const edited: Block = { ...base[2]!, type: "heading", level: 2 };
    const ops = diffPassage([base[2]!], [edited], "b001", newId);
    expect(ops).toEqual([
      {
        op: "replace",
        blockId: "b002",
        from: 0,
        to: 0,
        text: "",
        baseText: "",
        block: { type: "heading", level: 2 },
      },
    ]);
    expect(validateOps(base, ops)).toEqual([]);
    expect(changeKinds(ops)).toEqual(["modification"]);
    const { blocks, annotated } = consolidate(base, [{ id: "A", ops }]);
    expect(blocks[2]).toEqual(edited);
    expect(annotated[2]).toMatchObject({
      type: "heading",
      level: 2,
      status: "kept",
      format: { source: "A", changes: [{ code: "heading", value: 2 }] },
    });
    // A block that only changes its format still shows in the preview.
    expect(
      previewAmendment(base, { id: "A", ops }).map((block) => block.id),
    ).toEqual(["b002"]);
  });

  it("changes the kind, level, numbering and alignment of a list item", () => {
    const edited: Block[] = [
      listBase[0]!,
      { ...listBase[1]!, list: "ordered", marker: "a)" },
      { ...listBase[2]!, level: 0 },
      {
        ...p("l003", "Tercero"),
        align: "center",
      },
    ];
    const ops = diffPassage(listBase, edited, null, newId);
    expect(validateOps(listBase, ops)).toEqual([]);
    const { blocks, annotated } = consolidate(listBase, [{ id: "A", ops }]);
    expect(blocks).toEqual(edited);
    expect(annotated.map((block) => block.format?.changes)).toEqual([
      undefined,
      [{ code: "ordered_list" }, { code: "list_marker", value: "a)" }],
      [{ code: "list_level", value: 1 }],
      [{ code: "paragraph" }, { code: "align_center" }],
    ]);
    // Formats come out as the block schema stores them.
    expect(blocksSchema.parse(blocks)).toEqual(blocks);
  });

  it("does not take for a change what the editor does to a passage alone", () => {
    // A nested item edited without its parent comes back at the first
    // level, and a line break carries no marks.
    const nested: Block = {
      ...p("n001", "Uno\ndos", [{ type: "bold", from: 0, to: 7 }]),
      type: "list_item",
      level: 1,
      list: "bullet",
    };
    const echoed = editorToBlocks(blocksToEditor([nested]), newId);
    expect(echoed[0]).toMatchObject({ level: 0 });
    expect(echoed[0]!.marks).toHaveLength(2);
    expect(diffPassage([nested], echoed, null, newId)).toEqual([]);

    // What the author changes on top of that still counts.
    const edited: Block[] = [
      {
        ...echoed[0]!,
        text: "Uno\ntres",
        marks: [
          { type: "bold", from: 0, to: 3 },
          { type: "bold", from: 4, to: 8 },
        ],
      },
    ];
    const ops = diffPassage([nested], edited, null, newId);
    expect(ops).toEqual(diffText(nested, "Uno\ntres"));
  });

  it("keeps the format of new text where the stored marks are cut in pieces", () => {
    // An imported text stores one mark per piece: bold, bold and italic,
    // bold. The editor gives one bold over all of it.
    const imported = p("i001", "Hello world again", [
      { type: "bold", from: 0, to: 6 },
      { type: "bold", from: 6, to: 11 },
      { type: "italic", from: 6, to: 11 },
      { type: "bold", from: 11, to: 17 },
    ]);
    const echoed = editorToBlocks(blocksToEditor([imported]), newId);
    expect(diffPassage([imported], echoed, null, newId)).toEqual([]);

    const check = (text: string, marks: Block["marks"]) => {
      const edited: Block[] = [{ ...echoed[0]!, text, marks }];
      const ops = diffPassage([imported], edited, null, newId);
      expect(validateOps([imported], ops)).toEqual([]);
      const [result] = consolidate([imported], [{ id: "A", ops }]).blocks;
      expect(result!.text).toBe(text);
      // Every character ends up as the editor showed it.
      expect(
        editorToBlocks(blocksToEditor([result!]), newId)[0]!.marks,
      ).toEqual(marks);
    };
    // Typed where two pieces meet.
    check("Hello big world again", [
      { type: "bold", from: 0, to: 21 },
      { type: "italic", from: 10, to: 15 },
    ]);
    // Typed over two pieces.
    check("Hi there again", [{ type: "bold", from: 0, to: 14 }]);
  });

  it("does not take for a change a list that still starts at 1", () => {
    const item = (id: string, text: string, extra: Partial<Block> = {}) => ({
      ...p(id, text),
      type: "list_item" as const,
      level: 0,
      list: "ordered" as const,
      ...extra,
    });
    // Two lists in a row: only "starts at 1" tells the second from the first.
    const lists: Block[] = [
      item("o001", "a"),
      item("o002", "b"),
      item("o003", "c", { start: 1 }),
      item("o004", "d"),
    ];
    const echoed = editorToBlocks(blocksToEditor(lists), newId);
    expect(echoed).toEqual(lists);

    // A paragraph between them: the editor drops the start, which is the same.
    const parted = editorToBlocks(
      blocksToEditor([
        lists[0]!,
        lists[1]!,
        p("fresh", "Entre las dos"),
        lists[2]!,
        lists[3]!,
      ]),
      newId,
    );
    expect(parted[3]!.start).toBeUndefined();
    expect(diffPassage(lists, parted, null, newId)).toEqual([
      { op: "insert", afterBlockId: "o002", blocks: [parted[2]!] },
    ]);

    // Joining the two lists is a change: the numbering carries on.
    const joined = lists.map((block) => ({ ...block, start: undefined }));
    const ops = diffPassage(lists, joined, null, newId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      blockId: "o003",
      block: { list: "ordered" },
    });
  });

  it("drops a link the schema would not keep when reading the editor", () => {
    const linked = (href: string) =>
      editorToBlocks(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "b003" },
              content: [
                {
                  type: "text",
                  text: "Disposición final.",
                  marks: [{ type: "link", attrs: { href } }],
                },
              ],
            },
          ],
        },
        newId,
      );
    // Pasted over the text: no operation, as the server would see none.
    expect(linked("ftp://host/file")[0]!.marks).toEqual([]);
    expect(
      diffPassage([base[3]!], linked("ftp://host/file"), null, newId),
    ).toEqual([]);
    const ops = diffPassage(
      [base[3]!],
      linked(" https://creup.es "),
      null,
      newId,
    );
    expect(ops).toEqual(amendmentOpsSchema.parse(ops));
    expect(ops[0]).toMatchObject({
      marks: [{ type: "link", from: 0, to: 18, href: "https://creup.es" }],
    });
  });

  it("rejects formatting operations that change nothing or are malformed", () => {
    const reasons = (ops: AmendmentOp[], blocks = base) =>
      validateOps(blocks, ops).map((error) => error.reason);
    const format = (block: object, extra: object = {}): AmendmentOp =>
      ({
        op: "replace",
        blockId: "b002",
        from: 0,
        to: 0,
        text: "",
        baseText: "",
        block,
        ...extra,
      }) as AmendmentOp;

    expect(reasons([format({ type: "paragraph" })])).toEqual(["noop"]);
    expect(reasons([format({ type: "image" })])).toEqual(["format_shape"]);
    expect(reasons([format({ type: "heading", level: 9 })])).toEqual([
      "format_shape",
    ]);
    expect(reasons([format({ type: "quote" }, { marks: [] })])).toEqual([
      "format_shape",
    ]);
    expect(
      reasons([format({ type: "quote" }), format({ type: "heading" })]),
    ).toEqual(["duplicate_format"]);
    expect(
      reasons([
        format({ type: "quote" }),
        { op: "delete", blockIds: ["b002"] },
      ]),
    ).toEqual(["replace_in_deleted_block"]);

    const image: Block = {
      id: "i001",
      type: "image",
      text: "",
      marks: [],
      image: { asset: "a".repeat(24), width: 10, height: 10, alt: "" },
    };
    expect(
      reasons(
        [{ ...format({ type: "quote" }), blockId: "i001" } as never],
        [image],
      ),
    ).toEqual(["format_image"]);

    const marks = (list: Block["marks"]): AmendmentOp => ({
      op: "replace",
      blockId: "b002",
      from: 4,
      to: 18,
      text: "universidades ",
      baseText: "universidades ",
      marks: list,
    });
    expect(reasons([marks([])])).toEqual(["noop"]);
    expect(reasons([marks([{ type: "bold", from: 0, to: 40 }])])).toEqual([
      "marks_out_of_range",
    ]);
    expect(reasons([marks([{ type: "bold", from: 0, to: 13 }])])).toEqual([]);
    // Two changes of format over the same text collide like two of text.
    expect(
      reasons([
        marks([{ type: "bold", from: 0, to: 13 }]),
        marks([{ type: "italic", from: 0, to: 13 }]),
      ]),
    ).toEqual(["overlapping_ops"]);
  });

  it("counts a change of format as the text or the block it touches", () => {
    const boldOps = diffPassage([base[1]!], [bolded], "h001", newId);
    const sameText = diffText(
      base[1]!,
      base[1]!.text.replace("totalidad", "integridad"),
    );
    const otherText = diffText(
      base[1]!,
      base[1]!.text.replace("deberá", "tendrá que"),
    );
    expect(overlapBetween(boldOps, sameText)).toBe("same_text");
    expect(overlapBetween(boldOps, otherText)).toBeNull();

    const heading: AmendmentOp[] = [
      {
        op: "replace",
        blockId: "b001",
        from: 0,
        to: 0,
        text: "",
        baseText: "",
        block: { type: "heading", level: 3 },
      },
    ];
    // A new format takes the whole block.
    expect(overlapBetween(heading, otherText)).toBe("same_text");
    expect(overlapBetween(otherText, heading)).toBe("same_text");
    expect(overlapBetween(heading, heading)).toBe("same_text");
    expect(
      overlapBetween(heading, [{ op: "delete", blockIds: ["b001"] }]),
    ).toBe("removed_block");
    expect(
      overlapBetween(heading, [
        { op: "insert", afterBlockId: "b001", blocks: [p("x001", "Nuevo")] },
      ]),
    ).toBeNull();
    expect(
      findOverlaps([
        { id: "A", ops: heading },
        { id: "B", ops: otherText },
        { id: "C", ops: boldOps },
      ]).pairs,
    ).toEqual(
      expect.arrayContaining([
        { a: "A", b: "B", kind: "same_text" },
        { a: "A", b: "C", kind: "same_text" },
      ]),
    );

    // The second one to arrive is left out, never applied halfway.
    const result = consolidate(base, [
      { id: "A", ops: heading },
      { id: "B", ops: otherText },
      { id: "C", ops: diffText(base[2]!, "Otro texto.") },
    ]);
    expect(result.applied).toEqual(["A", "C"]);
    expect(result.conflicts).toEqual([
      { amendmentId: "B", conflictsWith: ["A"] },
    ]);
  });

  it("applies two amendments that format different parts of a block", () => {
    const first = diffPassage([base[1]!], [bolded], "h001", newId);
    const italicFrom = base[1]!.text.indexOf("créditos");
    const second = diffPassage(
      [base[1]!],
      [
        {
          ...base[1]!,
          marks: [{ type: "italic", from: italicFrom, to: italicFrom + 8 }],
        },
      ],
      "h001",
      newId,
    );
    const one = consolidate(base, [
      { id: "A", ops: first },
      { id: "B", ops: second },
    ]);
    const other = consolidate(base, [
      { id: "B", ops: second },
      { id: "A", ops: first },
    ]);
    expect(one.conflicts).toEqual([]);
    expect(one.blocks).toEqual(other.blocks);
    expect(one.blocks[1]!.marks).toEqual([
      { type: "bold", from: boldFrom, to: boldFrom + BOLD.length },
      { type: "italic", from: italicFrom, to: italicFrom + 8 },
    ]);
  });

  it("shows a change of format with its text once and a label in words", () => {
    const ops = diffPassage([base[1]!], [bolded], "h001", newId);
    const { annotated } = consolidate(base, [{ id: "A", ops }]);
    const html = renderAnnotated([annotated[1]!], {
      mode: "diff",
      diffLabels: labels,
    });
    expect(html).toContain(
      '<span class="cx-fmt" data-amendment-id="A">' +
        '<span class="sr-only">Cambia el formato: </span>' +
        "<strong>en su totalidad</strong>" +
        '<span class="cx-fmt-label">bold_on</span></span>',
    );
    expect(html).not.toContain("<del");
    expect(html).not.toContain("<ins");

    const hostile = renderAnnotated([annotated[1]!], {
      mode: "diff",
      diffLabels: { ...labels, format: () => "<b>&" },
    });
    expect(hostile).toContain(
      '<span class="cx-fmt-label">&lt;b&gt;&amp;</span>',
    );

    // Without words for it the text still shows its new format.
    expect(renderAnnotated([annotated[1]!], { mode: "diff" })).toContain(
      '<span class="cx-fmt" data-amendment-id="A"><strong>en su totalidad</strong></span>',
    );
    expect(renderAnnotated([annotated[1]!], { mode: "clean" })).toBe(
      renderBlocks([bolded]),
    );
    expect(
      renderAnnotated([annotated[1]!], {
        mode: "provenance",
        label: () => "7",
      }),
    ).toContain(
      '<span class="cx-prov" data-amendment-id="A"><strong>en su totalidad</strong></span><sup class="cx-ref" aria-hidden="true">7</sup>',
    );
  });

  it("shows a block in its new format with a label at its start", () => {
    const edited: Block = { ...base[2]!, type: "heading", level: 2 };
    const ops = diffPassage([base[2]!], [edited], "b001", newId);
    const { annotated } = consolidate(base, [{ id: "A", ops }]);
    const html = renderAnnotated([annotated[2]!], {
      mode: "diff",
      diffLabels: labels,
      focus: "A",
    });
    expect(html).toBe(
      '<h3 data-block-id="b002">' +
        '<span class="cx-fmt-label cx-fmt-block cx-focus" data-amendment-id="A">' +
        '<span class="sr-only">Cambia el formato: </span>heading 2</span>' +
        "Las universidades habilitarán un procedimiento de alegaciones.</h3>",
    );
    expect(renderAnnotated([annotated[2]!], { mode: "clean" })).toBe(
      renderBlocks([edited]),
    );
    expect(
      renderAnnotated([annotated[2]!], {
        mode: "provenance",
        label: () => "7",
      }),
    ).toBe(
      '<h3 data-block-id="b002"><span class="cx-prov" data-amendment-id="A">' +
        "Las universidades habilitarán un procedimiento de alegaciones.</span>" +
        '<sup class="cx-ref" aria-hidden="true">7</sup></h3>',
    );
  });

  it("parses operations with formatting and leaves the old ones as they were", () => {
    const old = [
      {
        op: "replace",
        blockId: "b001",
        from: 3,
        to: 11,
        text: "estudiantado",
        baseText: "alumnado",
      },
      { op: "delete", blockIds: ["b003"] },
    ];
    const parsed = amendmentOpsSchema.parse(old);
    expect(parsed).toEqual(old);
    expect(Object.keys(parsed[0]!)).toEqual(Object.keys(old[0]!));

    const [marked, formatted] = amendmentOpsSchema.parse([
      {
        op: "replace",
        blockId: "b001",
        from: 3,
        to: 11,
        text: "alumnado",
        baseText: "alumnado",
        marks: [
          { type: "bold", from: 0, to: 99 },
          { type: "italic", from: 4, to: 4 },
          { type: "link", from: 0, to: 4, href: "javascript:alert(1)" },
        ],
      },
      {
        op: "replace",
        blockId: "b002",
        from: 0,
        to: 0,
        text: "",
        baseText: "",
        block: { type: "list_item", marker: "a)", start: 3 },
      },
    ]);
    expect(marked).toMatchObject({
      marks: [{ type: "bold", from: 0, to: 8 }],
    });
    // A bullet keeps no marker and no start, like a stored block.
    expect(formatted).toMatchObject({
      block: { type: "list_item", level: 0, list: "bullet" },
    });
    expect(() =>
      amendmentOpsSchema.parse([
        {
          op: "replace",
          blockId: "b002",
          from: 0,
          to: 0,
          text: "",
          baseText: "",
          block: { type: "image" },
        },
      ]),
    ).toThrow();
  });
});

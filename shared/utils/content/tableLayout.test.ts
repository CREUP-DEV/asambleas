// Tables' width and place and their cells' sides (BlockCell.borders,
// tableWidth, tableAlign): the model, the editor's round trip, the HTML a
// DOCX import hands over and the web view.
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Block, BlockCell } from "../../types/content";
import { blocksSchema } from "../schemas/content";
import { blocksToEditor, editorToBlocks, htmlElementToBlocks } from "./editor";
import { renderBlocks } from "./render";
import {
  cellLayoutKey,
  formatCellBorders,
  gridEdges,
  groupTables,
  parseCellBorders,
  tableGrid,
  tableLayoutFields,
  tableLayoutOf,
  type TableGroup,
} from "./tables";

const at = (row: string, cell: string, extra: Partial<BlockCell> = {}) => ({
  table: "t0000000000000000000000",
  row: `r${row.padEnd(22, "0")}`,
  cell: `c${cell.padEnd(22, "0")}`,
  ...extra,
});

const block = (id: string, text: string, cell?: BlockCell): Block => ({
  id: `b${id.padEnd(23, "0")}`,
  type: "paragraph",
  text,
  marks: [],
  ...(cell ? { cell } : {}),
});

const tableOf = (blocks: Block[]) =>
  (groupTables(blocks)[0] as { kind: "table"; table: TableGroup<Block> }).table;

let ids = 0;
const newId = () => `n${String(++ids).padStart(23, "0")}`;

describe("table layout", () => {
  it("keeps sides and a narrower table's place, and drops the defaults", () => {
    const parsed = blocksSchema.parse([
      block("a", "x", {
        ...at("a", "a"),
        borders: { top: "thick", left: undefined, bottom: "none" },
        tableWidth: 48,
        tableAlign: "center",
      }),
      // As wide as the text: no width and no place.
      block("b", "y", {
        ...at("b", "b"),
        borders: {},
        tableWidth: 100,
        tableAlign: "right",
      }),
    ]);
    expect(parsed[0]!.cell).toEqual({
      ...at("a", "a"),
      borders: { top: "thick", bottom: "none" },
      tableWidth: 48,
      tableAlign: "center",
    });
    expect(parsed[1]!.cell).toEqual(at("b", "b"));
    expect(() =>
      blocksSchema.parse([block("c", "z", { ...at("c", "c"), tableWidth: 5 })]),
    ).toThrow();
    expect(() =>
      blocksSchema.parse([
        block("d", "z", {
          ...at("d", "d"),
          borders: { top: "dotted" as never },
        }),
      ]),
    ).toThrow();
  });

  it("reads a table's layout from its first cell", () => {
    expect(
      tableLayoutOf(
        tableOf([
          block("a", "x", {
            ...at("a", "a"),
            tableWidth: 48,
            tableAlign: "center",
          }),
        ]),
      ),
    ).toEqual({ width: 48, align: "center" });
    expect(tableLayoutOf(tableOf([block("a", "x", at("a", "a"))]))).toEqual({
      width: 100,
    });
    expect(tableLayoutFields("48", "center")).toEqual({
      tableWidth: 48,
      tableAlign: "center",
    });
    expect(tableLayoutFields(100, "center")).toEqual({});
    expect(tableLayoutFields("x", null)).toEqual({});
  });

  it("draws a shared side as the stronger of its two cells", () => {
    const grid = tableGrid(
      tableOf([
        block("a", "a", { ...at("a", "a"), borders: { right: "none" } }),
        block("b", "b", { ...at("a", "b"), borders: { left: "none" } }),
        block("c", "c", { ...at("b", "c"), borders: { right: "none" } }),
        // Only one of the two hides it: the rule stays.
        block("d", "d", { ...at("b", "d"), borders: { top: "thick" } }),
      ]),
    );
    const edges = [...gridEdges(grid).values()];
    expect(edges).toEqual([
      { top: "thin", right: "none", bottom: "thin", left: "thin" },
      { top: "thin", right: "thin", bottom: "thick", left: "none" },
      { top: "thin", right: "thin", bottom: "thin", left: "thin" },
      { top: "thick", right: "thin", bottom: "thin", left: "thin" },
    ]);
  });

  it("writes and reads sides as the DOCX import marks them", () => {
    expect(formatCellBorders({ left: "none", top: "thick" })).toBe(
      "top=thick;left=none",
    );
    expect(parseCellBorders("top=thick;left=none;oops=1;right=dotted")).toEqual(
      { top: "thick", left: "none" },
    );
    expect(parseCellBorders("")).toBeUndefined();
    // Changing a side or the width changes the text.
    expect(cellLayoutKey(at("a", "a"))).not.toEqual(
      cellLayoutKey({ ...at("a", "a"), borders: { top: "none" } }),
    );
    expect(cellLayoutKey({ ...at("a", "a"), tableWidth: 100 })).toEqual(
      cellLayoutKey(at("a", "a")),
    );
  });

  it("keeps sides, width and place through the editor", () => {
    const blocks = [
      block("a", "Nombre", {
        ...at("a", "a"),
        borders: { top: "thick", right: "none", bottom: "none", left: "none" },
        tableWidth: 48,
        tableAlign: "center",
      }),
    ];
    const doc = blocksToEditor(blocks);
    expect(doc.content![0]!.attrs).toMatchObject({
      tableWidth: 48,
      tableAlign: "center",
    });
    expect(editorToBlocks(doc, newId)).toEqual(blocks);
  });

  it("keeps a one-cell table with rules of its own, and blank lines", () => {
    const { document } = parseHTML(
      `<html><body>
        <table><tr><td><p>Nota</p></td></tr></table>
        <p data-blank=""></p>
        <p></p>
        <table data-table-width="48" data-table-align="center"><tr><td data-borders="top=thick;left=none;bottom=none;right=none"><p><strong>Nombre</strong></p></td></tr></table>
      </body></html>`,
    );
    const blocks = htmlElementToBlocks(document.body, newId);
    expect(
      blocks.map((item) => [
        item.text,
        item.cell ? item.cell.tableWidth : null,
      ]),
    ).toEqual([
      // A box with nothing of its own: its paragraphs.
      ["Nota", null],
      // Only a marked blank line stays.
      ["", null],
      ["Nombre", 48],
    ]);
    expect(blocks[2]!.cell).toMatchObject({
      borders: { top: "thick", left: "none", bottom: "none", right: "none" },
      tableAlign: "center",
    });
    // All bold, but a box: no header.
    expect(blocks[2]!.cell!.header).toBeUndefined();
  });

  it("shows a narrower table in its place and each cell's sides", () => {
    const html = renderBlocks([
      block("a", "Nombre", {
        ...at("a", "a"),
        borders: { top: "thick", right: "none" },
        tableWidth: 48,
        tableAlign: "center",
      }),
    ]);
    expect(html).toContain(
      '<table class="cx-table" style="--cx-table-width: 48%" data-cx-width="" data-cx-align="center" role="presentation">',
    );
    expect(html).toContain('<td data-cx-borders="top-thick right-none">');
    // A data table says nothing of the kind.
    const plain = renderBlocks([
      block("a", "1", at("a", "a")),
      block("b", "2", at("a", "b")),
    ]);
    expect(plain).toContain('<table class="cx-table"><tbody>');
  });
});

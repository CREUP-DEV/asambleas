// The adjustments made to mammoth's HTML before it becomes blocks
// (prepareImportedHtml), on HTML written as the converter writes it: no
// converter process runs here (see docx*.test.ts for that).

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Block } from "../../../shared/types/content";
import { htmlElementToBlocks } from "../../../shared/utils/content/editor";
import { groupTables } from "../../../shared/utils/content/tables";
import { prepareImportedHtml } from "./docxHtml";

/** Prepares `html` and walks it into blocks, saying whether tables split. */
function prepare(html: string): { blocks: Block[]; split: number } {
  const { document } = parseHTML(
    `<!doctype html><html><body>${html}</body></html>`,
  );
  let split = 0;
  prepareImportedHtml(document as unknown as Document, {
    onTablesSplit: () => (split += 1),
  });
  let id = 0;
  const blocks = htmlElementToBlocks(
    document.body as unknown as Element,
    () => `b${++id}`,
  );
  return { blocks, split };
}

/** Each table as its rows of cells, each cell as its blocks' text. */
function tables(blocks: Block[]): string[][][] {
  return groupTables(blocks).flatMap((run) =>
    run.kind === "table"
      ? [
          run.table.rows.map((row) =>
            row.cells.map((cell) =>
              cell.blocks.map((block) => block.text).join("/"),
            ),
          ),
        ]
      : [],
  );
}

const table = (...rows: string[]) => `<table>${rows.join("")}</table>`;
const tr = (...cells: string[]) => `<tr>${cells.join("")}</tr>`;
const td = (text: string) => (text ? `<td><p>${text}</p></td>` : "<td></td>");
/** A cell the converter marks as filled ("dark:rrggbb"). */
const filled = (fill: string, text: string, colspan = 1) =>
  `<td${colspan > 1 ? ` colspan="${colspan}"` : ""}><p><span class="docx-cell">${fill}</span>${text}</p></td>`;
/** A blank cell the converter marks as hiding its top and bottom rules. */
const spacer = '<td><p><span class="docx-gap">gap</span></p></td>';
const LEFT = "dark:163866";
const RIGHT = "dark:792225";

describe("prepareImportedHtml: tables side by side", () => {
  it("splits a summary of two tables into one after the other", () => {
    const { blocks, split } = prepare(
      table(
        tr(filled(LEFT, "Income", 3), spacer, filled(RIGHT, "Expenses", 3)),
        tr(
          td("1"),
          td("Fees"),
          td("100"),
          spacer,
          td("1"),
          td("Running costs"),
          td("120"),
        ),
        tr(
          td("2"),
          td("Grants"),
          td("50"),
          spacer,
          td("2"),
          td("Events"),
          td("30"),
        ),
        // Only the left table goes on: the right one is padded.
        tr(td("3"), td("Sales"), td("0"), spacer, td(""), td(""), td("")),
        tr(
          filled(LEFT, ""),
          filled(LEFT, "Total income"),
          filled(LEFT, "150"),
          spacer,
          filled(RIGHT, ""),
          filled(RIGHT, "Total expenses"),
          filled(RIGHT, "150"),
        ),
      ),
    );
    expect(split).toBe(1);
    expect(tables(blocks)).toEqual([
      [
        ["Income"],
        ["1", "Fees", "100"],
        ["2", "Grants", "50"],
        ["3", "Sales", "0"],
        ["", "Total income", "150"],
      ],
      [
        ["Expenses"],
        ["1", "Running costs", "120"],
        ["2", "Events", "30"],
        ["", "Total expenses", "150"],
      ],
    ]);
    // Headers keep their span, fill and header; the body cells stay plain.
    const cell = (text: string) =>
      blocks.find((block) => block.text === text)!.cell!;
    expect(cell("Income")).toMatchObject({
      header: true,
      fill: "blue",
      colspan: 3,
    });
    expect(cell("Expenses")).toMatchObject({
      header: true,
      fill: "burgundy",
      colspan: 3,
    });
    expect(cell("Total expenses")).toMatchObject({
      header: true,
      fill: "burgundy",
    });
    expect(cell("Fees").header).toBeUndefined();
    expect(cell("Fees").fill).toBeUndefined();
    expect(cell("Income").table).not.toBe(cell("Expenses").table);
    expect(blocks.some((block) => block.text.includes("gap"))).toBe(false);
  });

  it("splits at every spacer, header rows included, and keeps rows blank everywhere", () => {
    const head = '<th><p><span class="docx-gap">gap</span></p></th>';
    const { blocks, split } = prepare(
      `<table><thead><tr><th><p>A</p></th><th><p>B</p></th>${head}<th><p>C</p></th><th><p>D</p></th>${head}<th><p>E</p></th><th><p>F</p></th></tr></thead><tbody>${tr(
        td("a1"),
        td("b1"),
        spacer,
        td("c1"),
        td("d1"),
        spacer,
        td("e1"),
        td("f1"),
      )}${tr(td(""), td(""), spacer, td(""), td(""), spacer, td(""), td(""))}</tbody></table>`,
    );
    expect(split).toBe(1);
    expect(tables(blocks)).toEqual([
      [
        ["A", "B"],
        ["a1", "b1"],
        ["", ""],
      ],
      [
        ["C", "D"],
        ["c1", "d1"],
        ["", ""],
      ],
      [
        ["E", "F"],
        ["e1", "f1"],
        ["", ""],
      ],
    ]);
    expect(blocks.find((block) => block.text === "C")!.cell!.header).toBe(true);
  });

  it("keeps a blank row between a side's data rows, so its rows stay in line", () => {
    const th = (text: string) => `<th><p>${text}</p></th>`;
    const { blocks, split } = prepare(
      table(
        tr(th("University"), th("Delegate"), spacer, th("Yes"), th("No")),
        tr(td("UGR"), td("Ana"), spacer, td("X"), td("")),
        // Blank on the right but no padding: UPV's vote comes after it.
        tr(td("UCM"), td("Luis"), spacer, td(""), td("")),
        tr(td("UPV"), td("Eva"), spacer, td(""), td("X")),
      ),
    );
    expect(split).toBe(1);
    expect(tables(blocks)).toEqual([
      [
        ["University", "Delegate"],
        ["UGR", "Ana"],
        ["UCM", "Luis"],
        ["UPV", "Eva"],
      ],
      [
        ["Yes", "No"],
        ["X", ""],
        ["", ""],
        ["", "X"],
      ],
    ]);
  });

  it("lets each side mark its headers by its own fills", () => {
    const bold = (text: string) => `<td><p><strong>${text}</strong></p></td>`;
    const { blocks, split } = prepare(
      table(
        tr(
          filled(LEFT, "Income"),
          filled(LEFT, "Amount"),
          spacer,
          bold("Expenses"),
          bold("Cost"),
        ),
        tr(bold("Fees"), td("100"), spacer, td("Events"), td("30")),
      ),
    );
    expect(split).toBe(1);
    const cell = (text: string) =>
      blocks.find((block) => block.text === text)!.cell!;
    // The left side's headers are its dark cells, so its bold text is none.
    expect(cell("Income").header).toBe(true);
    expect(cell("Fees").header).toBeUndefined();
    // The right side has no dark cell: its bold row is its header.
    expect(cell("Expenses").header).toBe(true);
    expect(cell("Cost").header).toBe(true);
    expect(cell("Expenses").fill).toBeUndefined();
    expect(cell("Events").header).toBeUndefined();
  });

  it("leaves a table whole unless a clear spacer divides it", () => {
    const whole = (html: string, columns: number) => {
      const { blocks, split } = prepare(html);
      expect(split).toBe(0);
      const found = tables(blocks);
      expect(found).toHaveLength(1);
      expect(Math.max(...found[0]!.map((row) => row.length))).toBe(columns);
      expect(blocks.some((block) => block.text.includes("gap"))).toBe(false);
    };
    const pair = (middle: string) =>
      table(
        tr(td("a"), td("b"), middle, td("c"), td("d")),
        tr(td("e"), td("f"), middle, td("g"), td("h")),
      );
    // A blank column with its rules showing: a column to fill in.
    whole(pair("<td></td>"), 5);
    // A blank column on a fill, as a "Total" band draws one.
    whole(pair(filled("light:f5eee6", "")), 5);
    // A spacer at the edge divides nothing.
    whole(
      table(
        tr(spacer, td("a"), td("b"), td("c")),
        tr(spacer, td("d"), td("e"), td("f")),
      ),
      4,
    );
    // A title spanning the spacer.
    whole(
      table(
        tr('<td colspan="5"><p>Title</p></td>'),
        tr(td("a"), td("b"), spacer, td("c"), td("d")),
        tr(td("e"), td("f"), spacer, td("g"), td("h")),
      ),
      5,
    );
    // A spacer cell spanning two rows.
    whole(
      table(
        tr(
          td("a"),
          td("b"),
          '<td rowspan="2"><p><span class="docx-gap">gap</span></p></td>',
          td("c"),
          td("d"),
        ),
        tr(td("e"), td("f"), td("g"), td("h")),
      ),
      5,
    );
    // One row only.
    whole(table(tr(td("a"), td("b"), spacer, td("c"), td("d"))), 5);
    // A side of one column would read as paragraphs.
    whole(
      table(
        tr(td("a"), spacer, td("b"), td("c")),
        tr(td("d"), spacer, td("e"), td("f")),
      ),
      4,
    );
    // A side with no text.
    whole(
      table(
        tr(td("a"), td("b"), spacer, td(""), td("")),
        tr(td("c"), td("d"), spacer, td(""), td("")),
      ),
      5,
    );
    // A spacer marker in a cell with text is no spacer.
    whole(
      table(
        tr(
          td("a"),
          td("b"),
          '<td><p><span class="docx-gap">gap</span>x</p></td>',
          td("c"),
          td("d"),
        ),
        tr(td("e"), td("f"), spacer, td("g"), td("h")),
      ),
      5,
    );
  });

  it("keeps the spans within a side, and a side a span alone fills whole", () => {
    const spanned = (text: string) => `<td rowspan="2"><p>${text}</p></td>`;
    const kept = prepare(
      table(
        tr(spanned("A"), td("B"), spacer, td("c"), td("d")),
        tr(td("C"), spacer, td("e"), td("f")),
      ),
    );
    expect(kept.split).toBe(1);
    expect(tables(kept.blocks)).toEqual([
      [["A", "B"], ["C"]],
      [
        ["c", "d"],
        ["e", "f"],
      ],
    ]);
    expect(kept.blocks.find((block) => block.text === "A")!.cell!.rowspan).toBe(
      2,
    );
    // The left side's second row has no cell of its own: it would vanish
    // and stretch the spans over whatever follows.
    const whole = prepare(
      table(
        tr(spanned("A"), spanned("B"), spacer, td("c"), td("d")),
        tr(spacer, td("e"), td("f")),
      ),
    );
    expect(whole.split).toBe(0);
    expect(tables(whole.blocks)).toEqual([
      [
        ["A", "B", "", "c", "d"],
        ["", "e", "f"],
      ],
    ]);
  });

  it("leaves a table nested in a cell to be flattened", () => {
    const inner = table(
      tr(td("a"), td("b"), spacer, td("c"), td("d")),
      tr(td("e"), td("f"), spacer, td("g"), td("h")),
    );
    const { blocks, split } = prepare(
      table(tr(`<td>${inner}</td>`, td("x")), tr(td("y"), td("z"))),
    );
    expect(split).toBe(0);
    expect(tables(blocks)).toEqual([
      [
        ["a | b | c | d/e | f | g | h", "x"],
        ["y", "z"],
      ],
    ]);
  });
});

describe("prepareImportedHtml: page breaks", () => {
  const page = (where: "before" | "after") =>
    `<span class="docx-page">${where}</span>`;
  const breaks = (blocks: Block[]) =>
    blocks.filter((block) => block.pageBreak).map((block) => block.text);

  it("starts on a new page the paragraph a break comes ahead of", () => {
    const { blocks } = prepare(
      `<p>Firma</p><h2>${page("before")}Anexo I</h2><p>Texto</p>`,
    );
    expect(breaks(blocks)).toEqual(["Anexo I"]);
  });

  it("moves a break alone in its paragraph, or after the text, on", () => {
    const { blocks } = prepare(
      `<p>Uno</p><p>${page("before")}</p><p></p><p>Dos</p>` +
        `<p>${page("after")}Tres</p><h1>Cuatro</h1>`,
    );
    expect(breaks(blocks)).toEqual(["Dos", "Cuatro"]);
    expect(blocks.some((block) => block.text.includes("before"))).toBe(false);
  });

  it("drops a break before a list or inside a table", () => {
    const { blocks } = prepare(
      `<p>${page("after")}Uno</p><ul><li><p>Dos</p></li></ul>` +
        table(tr(`<td><p>${page("before")}Tres</p></td>`)),
    );
    expect(breaks(blocks)).toEqual([]);
  });
});

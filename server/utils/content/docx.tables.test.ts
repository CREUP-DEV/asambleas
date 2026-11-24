// DOCX import: a table's width, place and rules, and the blank lines a
// document leaves (a signature's room and line above all). The converter's
// tests are split over docx*.test.ts so that Vitest runs them side by side;
// their builders live in server/testing/docx.ts.

import { describe, expect, it, vi } from "vitest";
import { buildDocx, cell, cellWith, convert, p, row } from "../../testing/docx";

// mammoth must only run in the converter process.
vi.mock("mammoth", () => {
  const forbidden = () => {
    throw new Error("mammoth ran in the server process");
  };
  return { default: { convertToHtml: forbidden, images: {} } };
});

/** CREUP's template page: A4 with margins of 3 cm (8497 twentieths wide). */
const SECTION =
  '<w:sectPr><w:pgSz w:w="11909" w:h="16834"/><w:pgMar w:top="1843" w:right="1711" w:bottom="1394" w:left="1701"/></w:sectPr>';

const border = (side: string, value: string, size = 4) =>
  `<w:${side} w:val="${value}" w:sz="${size}" w:space="0" w:color="000000"/>`;

/** Every rule of a table, single and thin, as Google Docs writes them. */
const ALL_RULES = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => border(side, "single")).join("")}</w:tblBorders>`;

const tableWith = (properties: string, ...rows: string[]) =>
  `<w:tbl><w:tblPr>${properties}</w:tblPr>${rows.join("")}</w:tbl>`;

const centred = (text: string, run = "") =>
  `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${run ? `<w:rPr>${run}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("convertDocx tables and blank lines", { timeout: 30_000 }, () => {
  it("keeps a signature: its room, its centred box and its line", async () => {
    const result = await convert(
      await buildDocx(
        "<w:p/>" +
          p(null, "Y por tanto firmo los presentes presupuestos.") +
          "<w:p/><w:p/><w:p/>" +
          tableWith(
            `<w:tblW w:w="4110" w:type="dxa"/><w:tblInd w:w="2096" w:type="dxa"/>${ALL_RULES}`,
            row(
              cellWith(
                `<w:tcBorders>${border("top", "single", 12)}${border("left", "nil")}${border("bottom", "nil")}${border("right", "nil")}</w:tcBorders>`,
                centred("Nombre Apellido", "<w:b/>") +
                  centred("Tesorero de la Coordinadora", "<w:i/>"),
              ),
            ),
          ) +
          "<w:p/>" +
          SECTION,
      ),
    );
    const signature = {
      borders: { top: "thick", right: "none", bottom: "none", left: "none" },
      tableWidth: 48,
      tableAlign: "center",
    };
    expect(
      result.blocks.map((block) => [
        block.text,
        block.align ?? null,
        block.cell
          ? {
              borders: block.cell.borders,
              tableWidth: block.cell.tableWidth,
              tableAlign: block.cell.tableAlign,
            }
          : null,
        block.cell?.header ?? false,
      ]),
    ).toEqual([
      // Blank lines at the start and the end go; the room above stays.
      ["Y por tanto firmo los presentes presupuestos.", null, null, false],
      ["", null, null, false],
      ["", null, null, false],
      ["", null, null, false],
      // A box of one cell stays a table, and its bold name no header.
      ["Nombre Apellido", "center", signature, false],
      ["Tesorero de la Coordinadora", "center", signature, false],
    ]);
  });

  it("draws each side as Word does, the stronger of two cells", async () => {
    const result = await convert(
      await buildDocx(
        tableWith(
          // No rule between the columns.
          `<w:tblBorders>${["top", "left", "bottom", "right", "insideH"].map((side) => border(side, "single")).join("")}${border("insideV", "nil")}</w:tblBorders>`,
          row(cell(p(null, "a")), cell(p(null, "b"))),
          // The cell's own thick bottom rule; its neighbour's top takes it.
          row(
            cellWith(
              `<w:tcBorders>${border("bottom", "single", 12)}</w:tcBorders>`,
              p(null, "c"),
            ),
            cell(p(null, "d")),
          ),
          row(cell(p(null, "e")), cell(p(null, "f"))),
        ) + SECTION,
      ),
    );
    expect(
      result.blocks.map((block) => [block.text, block.cell?.borders ?? null]),
    ).toEqual([
      ["a", { right: "none" }],
      ["b", { left: "none" }],
      ["c", { right: "none", bottom: "thick" }],
      ["d", { left: "none" }],
      ["e", { top: "thick", right: "none" }],
      ["f", { left: "none" }],
    ]);
    // As wide as the text: no width of its own.
    expect(result.blocks.some((block) => block.cell?.tableWidth)).toBe(false);
  });

  it("leaves tables that set no rules, and boxes, as before", async () => {
    const result = await convert(
      await buildDocx(
        // A style's rules, which the converter does not read.
        `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${row(cell(p(null, "a")), cell("<w:p/>" + p(null, "b") + "<w:p/>"))}</w:tbl>` +
          p(null, "Entre tablas") +
          // A box of one cell with every rule: paragraphs, as before.
          tableWith(ALL_RULES, row(cell(p(null, "Nota")))) +
          SECTION,
      ),
    );
    expect(
      result.blocks.map((block) => [
        block.text,
        Boolean(block.cell),
        block.cell?.borders ?? null,
      ]),
    ).toEqual([
      ["a", true, null],
      // Blank lines in a cell go.
      ["b", true, null],
      ["Entre tablas", false, null],
      ["Nota", false, null],
    ]);
  });

  it("places a narrower table by its alignment or its indent", async () => {
    const box = (properties: string, text: string) =>
      tableWith(
        properties,
        row(
          cellWith(
            `<w:tcBorders>${border("top", "single", 12)}${border("left", "nil")}${border("bottom", "nil")}${border("right", "nil")}</w:tcBorders>`,
            p(null, text),
          ),
        ),
      ) + p(null, "·");
    const result = await convert(
      await buildDocx(
        box('<w:tblW w:w="2500" w:type="pct"/><w:jc w:val="right"/>', "a") +
          box('<w:tblW w:w="40%" w:type="pct"/>', "b") +
          // No width of its own: its columns'; at the end by its indent.
          box(
            '<w:tblW w:w="0" w:type="auto"/><w:tblInd w:w="5097" w:type="dxa"/>',
            "c",
          ).replace(
            "</w:tblPr>",
            '</w:tblPr><w:tblGrid><w:gridCol w:w="3400"/></w:tblGrid>',
          ) +
          SECTION,
      ),
    );
    const cells = result.blocks.filter((block) => block.cell);
    expect(
      cells.map((block) => [
        block.text,
        block.cell!.tableWidth ?? null,
        block.cell!.tableAlign ?? null,
      ]),
    ).toEqual([
      ["a", 50, "right"],
      ["b", 40, null],
      ["c", 40, "right"],
    ]);
  });
});

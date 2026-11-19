// DOCX import: the structure Word documents carry (titles, headings, lists,
// tables). The converter's tests are split over docx*.test.ts so that Vitest
// runs them side by side, since each spawns its converter processes one after
// another; their builders live in server/testing/docx.ts.

import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_MAX_BLOCKS } from "../../../shared/utils/schemas/content";
import { convertDocx, DOCX_LIMITS } from "./docx";
import {
  W,
  nextOwner,
  convert,
  buildDocx,
  p,
  convertTimed,
  cell,
  row,
  table,
  run,
} from "../../testing/docx";

// mammoth must only run in the converter process. If this process ever called
// it, every conversion below would fail.
vi.mock("mammoth", () => {
  const forbidden = () => {
    throw new Error("mammoth ran in the server process");
  };
  return { default: { convertToHtml: forbidden, images: {} } };
});

/** Relationships of the main document to the parts the tests below use. */
const STRUCTURE_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://creup.es" TargetMode="External"/>
</Relationships>`;

const STRUCTURE_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:style w:type="paragraph" w:styleId="Ttulo"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Cita"><w:name w:val="Quote"/></w:style>
</w:styles>`;

/** A level of an abstract numbering. */
const level = (ilvl: number, format: string, text: string, extra = "") =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>${extra}<w:lvlText w:val="${text}"/></w:lvl>`;

/**
 * Numbering for the tests below:
 * - 1 and 2 share an abstract numbering of "Artículo %1." and "%2)";
 * - 3 restarts that numbering at 1;
 * - 4 is a bulleted list;
 * - 5 has a level with no number at all.
 */
const STRUCTURE_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0">${level(0, "decimal", "Artículo %1.")}${level(1, "lowerLetter", "%2)")}${level(2, "upperRoman", "%1.%3", "<w:isLgl/>")}</w:abstractNum>
<w:abstractNum w:abstractNumId="1">${level(0, "bullet", "•")}</w:abstractNum>
<w:abstractNum w:abstractNumId="2">${level(0, "none", "")}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
<w:num w:numId="4"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="5"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;

/** A paragraph of numbering `numId` at `ilvl`, with an optional style. */
const numbered = (
  numId: number,
  ilvl: number,
  text: string,
  style: string | null = null,
) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;

/** A DOCX with styles, numbering, footnotes and a hyperlink `rIdL`. */
function structureDocx(body: string, footnotes: string[] = []) {
  return buildDocx(body, {
    "word/_rels/document.xml.rels": STRUCTURE_RELATIONSHIPS,
    "word/styles.xml": STRUCTURE_STYLES,
    "word/numbering.xml": STRUCTURE_NUMBERING,
    "word/footnotes.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${W}>${footnotes
      .map(
        (text, index) =>
          `<w:footnote w:id="${index + 1}"><w:p>${run(text)}</w:p></w:footnote>`,
      )
      .join("")}</w:footnotes>`,
  });
}

/** A run with `properties` (`<w:b/>`, `<w:caps/>`...). */
const styledRun = (properties: string, text: string) =>
  `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;

const summary = (blocks: { type: string; level?: number; text: string }[]) =>
  blocks.map((block) => [block.type, block.level ?? null, block.text]);

describe("convertDocx structure", { timeout: 30_000 }, () => {
  it("drops a Word title that repeats the document's title", async () => {
    const data = await structureDocx(
      p("Ttulo", "Resolución  sobre becas") + p("Ttulo1", "Exposición"),
    );
    const same = await convertDocx(data, {
      owner: nextOwner(),
      documentTitle: "resolución sobre becas.",
    });
    expect(summary(same.blocks)).toEqual([["heading", 1, "Exposición"]]);
    const other = await convertDocx(data, {
      owner: nextOwner(),
      documentTitle: "Otra resolución",
    });
    expect(summary(other.blocks)).toEqual([
      ["paragraph", null, "Resolución sobre becas"],
      ["heading", 1, "Exposición"],
    ]);
  });

  it("numbers lists and headings as Word shows them", async () => {
    // mammoth reads the numbering through a wrapper: if an upgrade bypasses
    // it, the numbers disappear and this test fails.
    const result = await convert(
      await structureDocx(
        numbered(1, 0, "Del objeto", "Ttulo2") +
          p(null, "Texto del artículo.") +
          numbered(1, 1, "Primero") +
          numbered(1, 1, "Segundo") +
          p(null, "Párrafo sin número.") +
          numbered(1, 1, "Tercero") +
          numbered(1, 2, "Legal") +
          // Another list of the same numbering continues it.
          numbered(2, 0, "Del ámbito", "Ttulo2") +
          numbered(2, 1, "Otra vez a") +
          // A restart begins again at 1.
          numbered(3, 0, "Reinicio", "Ttulo2") +
          numbered(4, 0, "Viñeta") +
          numbered(5, 0, "Sin número"),
      ),
    );
    // Headings and "1.1" keep their number as text; "a)" items stay a list
    // that starts again at 3 after the paragraph that interrupts it.
    expect(
      result.blocks.map((block) => [
        block.type,
        block.level ?? null,
        block.marker ?? null,
        block.start ?? null,
        block.text,
      ]),
    ).toEqual([
      ["heading", 2, null, null, "Artículo 1. Del objeto"],
      ["paragraph", null, null, null, "Texto del artículo."],
      ["list_item", 1, "a)", null, "Primero"],
      ["list_item", 1, "a)", null, "Segundo"],
      ["paragraph", null, null, null, "Párrafo sin número."],
      ["list_item", 1, "a)", 3, "Tercero"],
      ["paragraph", null, null, null, "1.1 Legal"],
      ["heading", 2, null, null, "Artículo 2. Del ámbito"],
      ["list_item", 1, "a)", null, "Otra vez a"],
      ["heading", 2, null, null, "Artículo 1. Reinicio"],
      ["list_item", 0, null, null, "Viñeta"],
      ["paragraph", null, null, null, "Sin número"],
    ]);
  });

  it("reads tables of one column as their content and others by rows", async () => {
    const link = `<w:hyperlink r:id="rIdL">${run("web")}</w:hyperlink>`;
    const result = await convert(
      await structureDocx(
        // A box around a signature: its paragraphs stay paragraphs.
        table(
          row(
            cell(
              p("Ttulo1", "Firma") +
                `<w:p>${styledRun("<w:b/>", "Nombre Apellido")}</w:p>` +
                `<w:p>${styledRun("<w:i/>", "Cargo")}</w:p>`,
            ),
          ),
        ),
      ),
    );
    expect(result.warnings).toEqual([]);
    expect(summary(result.blocks)).toEqual([
      ["heading", 1, "Firma"],
      ["paragraph", null, "Nombre Apellido"],
      ["paragraph", null, "Cargo"],
    ]);
    expect(result.blocks[1]!.marks).toEqual([
      { type: "bold", from: 0, to: 15 },
    ]);

    const rows = await convert(
      await structureDocx(
        table(
          row(
            cell(`<w:p>${styledRun("<w:b/>", "Órgano")}</w:p>`),
            cell(p(null, "Fecha")),
          ),
          row(
            cell(p(null, "Secretaría") + `<w:p>${link}</w:p>`),
            cell(
              numbered(4, 0, "uno") +
                numbered(4, 0, "dos") +
                table(row(cell(p(null, "x")), cell(p(null, "y")))),
            ),
          ),
        ),
      ),
    );
    // Only the table nested in a cell loses its layout.
    expect(rows.warnings).toEqual(["tables_flattened"]);
    expect(
      rows.blocks.map((block) => [
        block.type,
        block.text,
        block.cell?.header ?? false,
      ]),
    ).toEqual([
      // A cell all in bold reads as a header cell.
      ["paragraph", "Órgano", true],
      ["paragraph", "Fecha", false],
      ["paragraph", "Secretaría", false],
      ["paragraph", "web", false],
      ["list_item", "uno", false],
      ["list_item", "dos", false],
      ["paragraph", "x | y", false],
    ]);
    const cells = rows.blocks.map((block) => block.cell!);
    expect(new Set(cells.map((cell) => cell.table)).size).toBe(1);
    expect(new Set(cells.map((cell) => cell.row)).size).toBe(2);
    expect(new Set(cells.map((cell) => cell.cell)).size).toBe(4);
    expect(cells[2]!.cell).toBe(cells[3]!.cell);
    expect(cells[4]!.cell).toBe(cells[6]!.cell);
    expect(rows.blocks[3]!.marks).toEqual([
      { type: "link", from: 0, to: 3, href: "https://creup.es" },
    ]);
  });

  it("keeps spans, header rows and blank cells", async () => {
    const result = await convert(
      await structureDocx(
        table(
          `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(p(null, "A"))}${cell(p(null, "B"))}</w:tr>`,
          // Google Docs marks every row with an off header flag.
          `<w:tr><w:trPr><w:tblHeader w:val="0"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p(null, "AB")}</w:tc></w:tr>`,
          row(cell(p(null, "C")), cell("<w:p/>")),
        ),
      ),
    );
    expect(
      result.blocks.map((block) => [
        block.text,
        block.cell?.header ?? false,
        block.cell?.colspan ?? 1,
      ]),
    ).toEqual([
      ["A", true, 1],
      ["B", true, 1],
      ["AB", false, 2],
      ["C", false, 1],
      ["", false, 1],
    ]);
  });

  it("marks headers by a dark fill, not by bold, and gives each fill its nearest palette colour", async () => {
    const filled = (fill: string, content: string) =>
      `<w:tc><w:tcPr><w:shd w:val="clear" w:fill="${fill}"/></w:tcPr>${content}</w:tc>`;
    const result = await convert(
      await structureDocx(
        table(
          row(
            filled("792225", p(null, "Concepto", true)),
            filled("792225", "<w:p/>"),
          ),
          // Bold on a light fill: a line of the statement, no header.
          row(
            filled("f5eee6", p(null, "1. Ingresos", true)),
            filled("f5eee6", p(null, "10")),
          ),
          row(
            filled("a6a6a6", p(null, "Subtotal")),
            filled("a6a6a6", p(null, "20")),
          ),
          // Colours off the palette take the nearest one; white is no fill.
          row(
            filled("1F3864", p(null, "azul")),
            filled("E2EFD9", p(null, "claro")),
          ),
          row(
            filled("FFFFFF", p(null, "blanco")),
            filled("auto", p(null, "auto")),
          ),
        ) +
          // Without fills, a cell all in bold still reads as a header.
          table(row(cell(p(null, "Bold", true)), cell(p(null, "x")))),
      ),
    );
    expect(
      result.blocks.map((block) => [
        block.text,
        block.cell?.header ?? false,
        block.cell?.fill ?? null,
      ]),
    ).toEqual([
      ["Concepto", true, "burgundy"],
      ["", true, "burgundy"],
      // A light fill keeps its colour and makes no header.
      ["1. Ingresos", false, "beige"],
      ["10", false, "beige"],
      // Dark enough to be a header, in its own colour.
      ["Subtotal", true, "lightGrey"],
      ["20", true, "lightGrey"],
      ["azul", true, "blue"],
      ["claro", false, "beige"],
      ["blanco", false, null],
      ["auto", false, null],
      ["Bold", true, null],
      ["x", false, null],
    ]);
    // Imported content never writes the earlier `shade`.
    expect(result.blocks.some((block) => block.cell?.shade)).toBe(false);
  });

  it("leaves out a table of contents", async () => {
    const entry = (text: string) =>
      `<w:p><w:hyperlink w:anchor="_a">${run(text)}<w:r><w:tab/></w:r>${run("2")}</w:hyperlink></w:p>`;
    const result = await convert(
      await structureDocx(
        `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${entry("Introducción")}${entry("Cuentas")}</w:sdtContent></w:sdt>` +
          // Any other content control keeps its content.
          `<w:sdt><w:sdtPr/><w:sdtContent>${p(null, "Dentro")}</w:sdtContent></w:sdt>` +
          p("Ttulo1", "Introducción") +
          p(null, "Texto."),
      ),
    );
    expect(result.blocks.map((block) => [block.type, block.text])).toEqual([
      ["paragraph", "Dentro"],
      ["heading", "Introducción"],
      ["paragraph", "Texto."],
    ]);
  });

  it("keeps centred and right-aligned paragraphs, and drops justified ones", async () => {
    const aligned = (value: string, text: string) =>
      `<w:p><w:pPr><w:jc w:val="${value}"/></w:pPr>${run(text)}</w:p>`;
    const result = await convert(
      await structureDocx(
        aligned("right", "Última actualización") +
          aligned("center", "Firma") +
          aligned("end", "Al final") +
          aligned("both", "Justificado") +
          `<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>`,
      ),
    );
    expect(
      result.blocks.map((block) => [block.text, block.align ?? null]),
    ).toEqual([
      ["Última actualización", "right"],
      ["Firma", "center"],
      ["Al final", "right"],
      ["Justificado", null],
    ]);
  });

  it("turns footnotes into paragraphs that keep their number", async () => {
    const reference = `<w:r><w:footnoteReference w:id="1"/></w:r>`;
    const result = await convert(
      await structureDocx(
        `<w:p>${run("Texto con nota")}${reference}${run(" y sigue.")}</w:p>`,
        ["Contenido de la nota."],
      ),
    );
    expect(result.blocks.map((block) => block.text)).toEqual([
      "Texto con nota[1] y sigue.",
      "[1] Contenido de la nota.",
    ]);
  });

  it("turns thousands of footnotes into paragraphs without stalling", async () => {
    // 100 paragraphs of 29 references each, and their 2,900 notes: the
    // block limit.
    const count = 2_900;
    const paragraphs = Array.from({ length: 100 }, (_, paragraph) => {
      const references = Array.from(
        { length: 29 },
        (_, index) =>
          `<w:r><w:footnoteReference w:id="${paragraph * 29 + index + 1}"/></w:r>`,
      ).join("");
      return `<w:p>${run("Notas")}${references}</w:p>`;
    }).join("");
    const data = await structureDocx(
      paragraphs,
      Array.from({ length: count }, (_, index) => `Nota ${index + 1}`),
    );
    const { value, error, longestStall } = await convertTimed(
      data,
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks.at(-1)!.text).toBe(`[${count}] Nota ${count}`);
    expect(longestStall).toBeLessThan(3_000);
  });

  it("leaves links without an underline of their own", async () => {
    const result = await convert(
      await structureDocx(
        `<w:p>${run("Ver ")}<w:hyperlink r:id="rIdL">${styledRun('<w:u w:val="single"/>', "la web")}</w:hyperlink></w:p>`,
      ),
    );
    expect(result.blocks[0]!.marks).toEqual([
      { type: "link", from: 4, to: 10, href: "https://creup.es" },
    ]);
  });

  it("keeps ordinals, capitals, quotes and underline, and warns of highlights", async () => {
    const result = await convert(
      await structureDocx(
        `<w:p>${run("La 80")}${styledRun('<w:vertAlign w:val="superscript"/>', "a")}${run(" AGO, el m")}${styledRun('<w:vertAlign w:val="superscript"/>', "2")}${run(" y la")}${styledRun('<w:vertAlign w:val="superscript"/>', "a")}</w:p>` +
          `<w:p>${styledRun("<w:caps/>", "mayúsculas")}${run(" y ")}${styledRun('<w:u w:val="single"/>', "subrayado")}</w:p>` +
          p("Cita", "Una cita") +
          `<w:p>${styledRun('<w:highlight w:val="none"/>', "sin resaltar")}</w:p>`,
      ),
    );
    expect(result.warnings).toEqual([]);
    expect(summary(result.blocks)).toEqual([
      ["paragraph", null, "La 80ª AGO, el m2 y laa"],
      ["paragraph", null, "MAYÚSCULAS y subrayado"],
      ["quote", null, "Una cita"],
      ["paragraph", null, "sin resaltar"],
    ]);
    expect(result.blocks[1]!.marks).toEqual([
      { type: "underline", from: 13, to: 22 },
    ]);

    const highlighted = await convert(
      await structureDocx(
        `<w:p>${styledRun('<w:highlight w:val="yellow"/>', "importante")}</w:p>`,
      ),
    );
    expect(highlighted.warnings).toEqual(["highlight"]);
  });
});

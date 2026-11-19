// DOCX import: bounds on the converter's HTML, blocks and tables. The
// converter's tests are split over docx*.test.ts so that Vitest runs them side
// by side, since each spawns its converter processes one after another; their
// builders live in server/testing/docx.ts.

import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_MAX_BLOCKS } from "../../../shared/utils/schemas/content";
import { DOCX_LIMITS } from "./docx";
import {
  convert,
  p,
  convertTimed,
  cell,
  row,
  table,
  nestedTables,
  boldItalic,
  deflatedDocx,
  listDocx,
  item,
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

// Parsing and walking the converter's HTML runs on this process's event loop.
// Before these bounds, a 4 KB file of 30,000 paragraphs blocked it for 22 s,
// and an 8 KB file of 7 MB of text in nested tables for 38 s. The stall
// ceilings below are loose so that a busy machine does not fail them; the
// bounds keep the real stalls far below.
describe("convertDocx HTML bounds", { timeout: 60_000 }, () => {
  it("refuses a tiny file of 30,000 paragraphs without stalling", async () => {
    const data = deflatedDocx(p(null, "x").repeat(30_000));
    expect(data.length).toBeLessThan(16 * 1024);
    const started = Date.now();
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("still converts 3,000 paragraphs, the block limit", async () => {
    // Each entity becomes nodes of its own; a few per paragraph are fine.
    const data = deflatedDocx(
      p(null, "Texto de I+D &amp; innovación: 3 &lt; 4 y 5 &gt; 2.").repeat(
        DOCUMENT_MAX_BLOCKS,
      ),
    );
    const { value, error, longestStall } = await convertTimed(
      data,
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks[0]!.text).toBe(
      "Texto de I+D & innovación: 3 < 4 y 5 > 2.",
    );
    expect(new Set(value!.blocks.map((block) => block.id)).size).toBe(
      DOCUMENT_MAX_BLOCKS,
    );
    expect(longestStall).toBeLessThan(3_000);
  });

  it("still converts 3,000 densely formatted paragraphs", async () => {
    // Ten bold or italic words among plain text: about 93,000 nodes.
    let paragraph = "";
    for (let word = 0; word < 10; word++) {
      const style = word % 2 ? "<w:b/>" : "<w:i/>";
      paragraph += `<w:r><w:rPr>${style}</w:rPr><w:t>palabra</w:t></w:r><w:r><w:t xml:space="preserve"> y </w:t></w:r>`;
    }
    const data = deflatedDocx(
      `<w:p>${paragraph}</w:p>`.repeat(DOCUMENT_MAX_BLOCKS),
    );
    const { value, error, longestStall } = await convertTimed(
      data,
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks[0]!.marks).toHaveLength(10);
    expect(longestStall).toBeLessThan(3_000);
  });

  it("stops the walk at the first block past the limit", async () => {
    // Few enough paragraphs to pass the element count before parsing.
    const data = deflatedDocx(p(null, "x").repeat(DOCUMENT_MAX_BLOCKS + 200));
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(3_000);

    const three = deflatedDocx(
      p(null, "Uno") + p(null, "Dos") + p(null, "Tres"),
    );
    await expect(
      convert(three, { ...DOCX_LIMITS, maxBlocks: 2 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const result = await convert(three, { ...DOCX_LIMITS, maxBlocks: 3 });
    expect(result.blocks).toHaveLength(3);
  });

  it("counts the elements the walk visits, text or not", async () => {
    const data = deflatedDocx(p(null, " ").repeat(3) + p(null, "Texto"));
    await expect(
      convert(data, { ...DOCX_LIMITS, maxBlockElements: 3 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const result = await convert(data, { ...DOCX_LIMITS, maxBlockElements: 4 });
    expect(result.blocks.map((block) => block.text)).toEqual(["Texto"]);
  });

  it("counts table rows, not the paragraphs in their cells", async () => {
    const twoRows = table(
      row(cell(p(null, "a")), cell(p(null, "b")), cell(p(null, "c"))),
      row(cell(p(null, "d")), cell(p(null, "e")), cell(p(null, "f"))),
    );
    const data = deflatedDocx(twoRows);
    const result = await convert(data, { ...DOCX_LIMITS, maxBlockElements: 2 });
    expect(result.blocks.map((block) => block.text)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxBlockElements: 1 }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses tables nested deeper than the limit", async () => {
    // table > tr > td > table > tr > td > p
    const data = deflatedDocx(nestedTables(2, p(null, "x")));
    const result = await convert(data, { ...DOCX_LIMITS, maxHtmlDepth: 7 });
    // Tables of one column are read as the text inside them.
    expect(result.blocks.map((block) => block.text)).toEqual(["x"]);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxHtmlDepth: 6 }),
    ).rejects.toMatchObject({ statusCode: 422 });

    // Each nested table makes the walk read every cell below it again: 300
    // levels took 0.6 s, and the cost grows with the cube of the depth.
    const deep = deflatedDocx(nestedTables(150, p(null, "x")));
    const { error, longestStall } = await convertTimed(deep, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("counts marks and list copies in tables like those outside", async () => {
    const marked = deflatedDocx(
      table(row(cell(`<w:p>${boldItalic("x")}</w:p>`), cell(p(null, "y")))),
    );
    await expect(
      convert(marked, { ...DOCX_LIMITS, maxMarks: 1 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const result = await convert(marked, { ...DOCX_LIMITS, maxMarks: 2 });
    expect(result.blocks[0]!.marks.map((mark) => mark.type).sort()).toEqual([
      "bold",
      "italic",
    ]);

    // A table of one column is walked like the text around it, copies
    // included.
    const nested = listDocx(
      table(row(cell(item(0, run("a")) + item(1, run("b"))))),
    );
    await expect(
      convert(nested, { ...DOCX_LIMITS, maxListCopies: 5 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const nestedResult = await convert(nested);
    expect(nestedResult.blocks.map((block) => block.level)).toEqual([0, 1]);
  });

  it("still converts a table of 3,000 formatted cells, the block limit", async () => {
    const formatted = cell(`<w:p>${boldItalic("palabra")}</w:p>`);
    const linked = cell(
      `<w:p><w:hyperlink r:id="rIdL">${run("web")}</w:hyperlink></w:p>`,
    );
    const rows = (count: number) =>
      deflatedDocx(
        table(
          row(linked, ...Array.from({ length: 5 }, () => formatted)).repeat(
            count,
          ),
        ),
      );
    const { value, error, longestStall } = await convertTimed(
      rows(DOCUMENT_MAX_BLOCKS / 6),
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    // Every cell is a block.
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks[1]!.marks).toHaveLength(2);
    expect(longestStall).toBeLessThan(3_000);

    // 3,000 rows of six cells are past the limit: refused, quickly.
    const large = await convertTimed(rows(DOCUMENT_MAX_BLOCKS), DOCX_LIMITS);
    expect(large.error).toMatchObject({ statusCode: 422 });
    expect(large.longestStall).toBeLessThan(3_000);
  });

  it("converts or refuses tables up to the node limit without stalling", async () => {
    // Many tiny formatted cells: about 95,000 nodes.
    const cells = Array.from({ length: 19 }, () =>
      cell(`<w:p>${boldItalic("x")}</w:p>`),
    ).join("");
    const tiny = await convertTimed(
      deflatedDocx(table(row(cells).repeat(1_000))),
      DOCX_LIMITS,
    );
    expect(tiny.longestStall).toBeLessThan(3_000);

    // A box of one column holding paragraphs with nothing to keep, which
    // yield no block, and one holding more paragraphs than blocks allowed.
    const blank = await convertTimed(
      deflatedDocx(table(row(cell(p(null, " ").repeat(45_000))))),
      DOCX_LIMITS,
    );
    expect(blank.longestStall).toBeLessThan(3_000);
    const full = await convertTimed(
      deflatedDocx(table(row(cell(p(null, "x").repeat(30_000))))),
      DOCX_LIMITS,
    );
    expect(full.error).toMatchObject({ statusCode: 422 });
    expect(full.longestStall).toBeLessThan(3_000);
  });
});

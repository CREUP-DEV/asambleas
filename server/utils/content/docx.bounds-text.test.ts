// DOCX import: bounds on the converter's HTML, marks, text and lists. The
// converter's tests are split over docx*.test.ts so that Vitest runs them side
// by side, since each spawns its converter processes one after another; their
// builders live in server/testing/docx.ts.

import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_MAX_BLOCKS } from "../../../shared/utils/schemas/content";
import { DOCX_LIMITS } from "./docx";
import {
  convert,
  p,
  MiB,
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
  lines,
  spaced,
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
  it("counts one mark per formatting element around each run of text", async () => {
    const data = deflatedDocx(`<w:p>${boldItalic("x")}</w:p>`);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxMarks: 1 }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const result = await convert(data, { ...DOCX_LIMITS, maxMarks: 2 });
    expect(result.blocks[0]!.marks.map((mark) => mark.type).sort()).toEqual([
      "bold",
      "italic",
    ]);
  });

  it("refuses marks multiplied by nested links without stalling", async () => {
    // Every run of text inside 26 nested links gets 28 marks.
    let body = boldItalic("x").replace(
      "</w:t></w:r>",
      `</w:t>${"<w:br/><w:t>x</w:t>".repeat(10_000)}</w:r>`,
    );
    for (let level = 0; level < 26; level++) {
      body = `<w:hyperlink r:id="rIdL">${body}</w:hyperlink>`;
    }
    const data = deflatedDocx(`<w:p>${body}</w:p>`);
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("refuses long text without stalling, in nested tables or not", async () => {
    // The walk collapses the spaces of every cell nested in a row again for
    // each row and cell around it: 55 times ten tables deep.
    const nested = deflatedDocx(nestedTables(10, p(null, spaced(3 * MiB))));
    expect(nested.length).toBeLessThan(16 * 1024);
    const inTables = await convertTimed(nested, DOCX_LIMITS);
    expect(inTables.error).toMatchObject({ statusCode: 422 });
    expect(inTables.longestStall).toBeLessThan(1_000);

    const paragraph = deflatedDocx(p(null, spaced(7 * MiB)));
    const alone = await convertTimed(paragraph, DOCX_LIMITS);
    expect(alone.error).toMatchObject({ statusCode: 422 });
    expect(alone.longestStall).toBeLessThan(1_000);
  });

  it("counts the text of each block, rows with everything nested in them", async () => {
    const limits = { ...DOCX_LIMITS, maxBlockTextBytes: 4 };
    const paragraphs = deflatedDocx(p(null, "abcd") + p(null, "efgh"));
    const result = await convert(paragraphs, limits);
    expect(result.blocks.map((block) => block.text)).toEqual(["abcd", "efgh"]);
    await expect(
      convert(paragraphs, { ...limits, maxBlockTextBytes: 3 }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const rows = deflatedDocx(
      table(
        row(cell(p(null, "ab")), cell(p(null, "cd"))),
        row(cell(p(null, "ef")), cell(nestedTables(1, p(null, "gh")))),
      ),
    );
    const tableResult = await convert(rows, limits);
    // Each cell is a block; the one-column table nested in a cell is read
    // as that cell's text.
    expect(tableResult.blocks.map((block) => block.text)).toEqual([
      "ab",
      "cd",
      "ef",
      "gh",
    ]);
    await expect(
      convert(rows, { ...limits, maxBlockTextBytes: 3 }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("counts again the text nested tables make the walk read again", async () => {
    const text = "a".repeat(1_000);
    const limits = { ...DOCX_LIMITS, maxWalkReads: 2_000 };
    // Read once outside tables, three times two tables deep.
    const plain = await convert(deflatedDocx(p(null, text)), limits);
    expect(plain.blocks.map((block) => block.text)).toEqual([text]);
    const nested = deflatedDocx(nestedTables(2, p(null, text)));
    await expect(convert(nested, limits)).rejects.toMatchObject({
      statusCode: 422,
    });
    const result = await convert(nested);
    expect(result.blocks.map((block) => block.text)).toEqual([text]);
  });

  it("refuses text read again in many nested tables without stalling", async () => {
    // Each table alone fits in the budget; together they do not.
    const data = deflatedDocx(
      nestedTables(10, p(null, spaced(20 * 1024))).repeat(8),
    );
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);

    // Nodes count as well as text: 45,000 line breaks ten tables deep.
    const breaks = deflatedDocx(
      nestedTables(10, `<w:p>${lines(45_000)}</w:p>`),
    );
    const nodes = await convertTimed(breaks, DOCX_LIMITS);
    expect(nodes.error).toMatchObject({ statusCode: 422 });
    expect(nodes.longestStall).toBeLessThan(1_000);
  });

  it("counts a text node for every entity", async () => {
    // `a &amp; b`: three text nodes in one paragraph.
    const data = deflatedDocx(p(null, "a &amp; b"));
    const result = await convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 4 });
    expect(result.blocks.map((block) => block.text)).toEqual(["a & b"]);
    await expect(
      convert(data, { ...DOCX_LIMITS, maxHtmlNodes: 3 }),
    ).rejects.toMatchObject({ statusCode: 413 });

    // Each of them takes the marks around it.
    const bold = deflatedDocx(p(null, "a&amp;b", true));
    await expect(
      convert(bold, { ...DOCX_LIMITS, maxMarks: 3 }),
    ).resolves.toBeDefined();
    await expect(
      convert(bold, { ...DOCX_LIMITS, maxMarks: 2 }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses a tiny file full of entities without stalling", async () => {
    // 120,000 text nodes. Counted as one each, 7 MB of them blocked the
    // event loop for 7.8 s.
    const data = deflatedDocx(p(null, "&amp;".repeat(15_000)).repeat(4));
    expect(data.length).toBeLessThan(16 * 1024);
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 413 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("counts the copies the walk makes of nested list items", async () => {
    // Flat, each node is copied once: four. Nested, the second item and its
    // text three times each, and its list once: nine.
    const flat = listDocx(item(0, run("a")) + item(0, run("b")));
    const nested = listDocx(item(0, run("a")) + item(1, run("b")));
    const limits = { ...DOCX_LIMITS, maxListCopies: 5 };
    const result = await convert(flat, limits);
    expect(
      result.blocks.map((block) => [block.type, block.level, block.text]),
    ).toEqual([
      ["list_item", 0, "a"],
      ["list_item", 0, "b"],
    ]);
    await expect(convert(nested, limits)).rejects.toMatchObject({
      statusCode: 422,
    });
    const nestedResult = await convert(nested);
    expect(nestedResult.blocks.map((block) => block.level)).toEqual([0, 1]);
  });

  it("refuses deeply nested list items without stalling", async () => {
    // 90,000 nodes five lists deep took 2 to 3.5 s to walk.
    let body = "";
    for (let level = 0; level < 4; level++) body += item(level, run("x"));
    const data = listDocx(body + item(4, lines(45_000)));
    const { error, longestStall } = await convertTimed(data, DOCX_LIMITS);
    expect(error).toMatchObject({ statusCode: 422 });
    expect(longestStall).toBeLessThan(1_000);
  });

  it("still converts a list of 3,000 densely formatted items", async () => {
    let runs = "";
    for (let word = 0; word < 10; word++) {
      const style = word % 2 ? "<w:b/>" : "<w:i/>";
      runs += `<w:r><w:rPr>${style}</w:rPr><w:t>palabra</w:t></w:r>${run(" y ")}`;
    }
    const data = listDocx(item(0, runs).repeat(DOCUMENT_MAX_BLOCKS));
    const { value, error, longestStall } = await convertTimed(
      data,
      DOCX_LIMITS,
    );
    expect(error).toBeNull();
    expect(value!.blocks).toHaveLength(DOCUMENT_MAX_BLOCKS);
    expect(value!.blocks[0]!.type).toBe("list_item");
    expect(longestStall).toBeLessThan(3_000);
  });
});

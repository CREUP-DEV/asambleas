import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { Block } from "../../../shared/types/content";
import { buildDocumentDocx } from "./docxWriter";

const cellBlock = (table: string, row: string, cell: string): Block => ({
  id: `${table}-${row}-${cell}`,
  type: "paragraph",
  text: `${table} ${row} ${cell}`,
  marks: [],
  cell: { table, row, cell: `${table}-${row}-${cell}` },
});

/** A table of two rows of two cells. */
const twoByTwo = (table: string): Block[] =>
  ["r1", "r2"].flatMap((row) =>
    ["c1", "c2"].map((cell) => cellBlock(table, row, cell)),
  );

describe("buildDocumentDocx", () => {
  it("keeps consecutive tables apart with a paragraph", async () => {
    const buffer = await buildDocumentDocx({
      title: "Presupuesto",
      assemblyLabel: "80.ª AGO",
      pageCount: "{page} de {total}",
      blocks: [...twoByTwo("t1"), ...twoByTwo("t2")],
    });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml.match(/<w:tbl>/g)).toHaveLength(2);
    // Word would join two tables with nothing between them into one.
    const end = xml.indexOf("</w:tbl>");
    const between = xml.slice(end, xml.indexOf("<w:tbl>", end));
    expect(between).toMatch(/^<\/w:tbl>\s*<w:p(\/>|[\s>][^]*<\/w:p>)\s*$/);
  });
});

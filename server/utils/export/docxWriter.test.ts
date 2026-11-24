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

  it("keeps a table's width, place and cells' sides", async () => {
    const buffer = await buildDocumentDocx({
      title: "Presupuesto",
      assemblyLabel: "80.ª AGO",
      pageCount: "{page} de {total}",
      blocks: [
        {
          id: "sig",
          type: "paragraph",
          text: "Nombre Apellido",
          marks: [],
          cell: {
            table: "t",
            row: "r",
            cell: "c",
            borders: {
              top: "thick",
              right: "none",
              bottom: "none",
              left: "none",
            },
            tableWidth: 48,
            tableAlign: "center",
          },
        },
      ],
    });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    // In fiftieths of a percent, as Word reads it back.
    expect(xml).toMatch(/<w:tblW w:type="pct" w:w="2400"\/>/);
    expect(xml).toMatch(/<w:jc w:val="center"\/>/);
    const borders = /<w:tcBorders>(.*?)<\/w:tcBorders>/.exec(xml)![1]!;
    expect(borders).toMatch(/<w:top w:val="single"[^>]*w:sz="12"/);
    expect(borders).toMatch(/<w:left w:val="none"/);

    const blue = await buildDocumentDocx({
      title: "Presupuesto",
      assemblyLabel: "80.ª AGO",
      pageCount: "{page} de {total}",
      blocks: [
        {
          id: "b",
          type: "paragraph",
          text: "Azul",
          marks: [],
          cell: { table: "t", row: "r", cell: "c", borderColor: "blue" },
        },
      ],
    });
    const blueXml = await (
      await JSZip.loadAsync(blue)
    )
      .file("word/document.xml")!
      .async("string");
    expect(/<w:tcBorders>(.*?)<\/w:tcBorders>/.exec(blueXml)![1]).toMatch(
      /<w:top w:val="single" w:color="163866"/,
    );
  });
});

import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  columnLetters,
  xlsxParts,
  xlsxSheetNames,
  xmlEscape,
  type XlsxWorkbook,
} from "./xlsx";

const book = (over: Partial<XlsxWorkbook> = {}): XlsxWorkbook => ({
  title: "Hoja de control de la 80.ª AGO",
  created: new Date("2026-11-21T15:40:00.000Z"),
  sheets: [
    {
      name: "General",
      lines: ["Hoja de control", "Exportada el 21 de noviembre de 2026"],
      columns: [
        { header: "Nº", width: 7 },
        { header: "Punto", width: 40 },
      ],
      rows: [
        ["1.", "Ratificación de la Mesa"],
        ["2.", "Actas <anteriores> & más"],
      ],
    },
    {
      name: "Posicionamiento sobre el Sistema de Becas",
      lines: ["Becas"],
      columns: [{ header: "Enmienda", width: 12 }],
      rows: [],
    },
  ],
  ...over,
});

describe("xlsx", () => {
  it("names columns as Excel does", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetters)).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
      "ZZ",
      "AAA",
    ]);
  });

  it("makes sheet names valid and unique", () => {
    expect(
      xlsxSheetNames([
        "Posicionamiento sobre el Sistema de Becas",
        "Posicionamiento sobre el Sistema de Becas",
        "Resolución: 1/2 [borrador]?",
        "'citada'",
        "",
      ]),
    ).toEqual([
      "Posicionamiento sobre el Sistem",
      "Posicionamiento sobre el Si (2)",
      "Resolución 1 2 borrador",
      "citada",
      "Hoja 5",
    ]);
  });

  it("escapes text and drops what XML cannot carry", () => {
    expect(xmlEscape(`a < b & "c"\u0001`)).toBe("a &lt; b &amp; &quot;c&quot;");
  });

  it("writes a sheet per tab with its lines, header and rows", () => {
    const parts = xlsxParts(book());
    expect(Object.keys(parts)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "xl/workbook.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
        "xl/styles.xml",
      ]),
    );
    const general = parts["xl/worksheets/sheet1.xml"]!;
    // Two lines, a blank row, the header on row 4, frozen under it.
    expect(general).toContain('<c r="A1" s="3" t="inlineStr">');
    expect(general).toContain('<c r="A4" s="2" t="inlineStr">');
    expect(general).toContain('ySplit="4" topLeftCell="A5"');
    expect(general).toContain('<autoFilter ref="A4:B6"/>');
    expect(general).toContain("Actas &lt;anteriores&gt; &amp; más");
    expect(parts["xl/workbook.xml"]).toContain(
      `<sheet name="Posicionamiento sobre el Sistem" sheetId="2" r:id="rId2"/>`,
    );
    expect(parts["xl/workbook.xml"]).toContain("'General'!$A$4:$B$6");
    // An empty table has no filter.
    expect(parts["xl/worksheets/sheet2.xml"]).not.toContain("autoFilter");
  });

  it("zips into a package JSZip reads back", async () => {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(xlsxParts(book()))) {
      zip.file(path, content);
    }
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const read = await JSZip.loadAsync(bytes);
    expect(await read.file("docProps/core.xml")!.async("string")).toContain(
      "2026-11-21T15:40:00Z",
    );
  });
});

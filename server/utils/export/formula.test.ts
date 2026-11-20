import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import type { Block } from "../../../shared/types/content";
import { blocksToPdf, LinkRegistry } from "./content";
import { buildDocumentDocx } from "./docxWriter";
import { formulaToDocx } from "./formulaDocx";
import { formulaSvg } from "./formulaSvg";
import {
  RALEWAY_FILES,
  pdfmake,
  registerPdfFonts,
  type RalewayFile,
} from "./pdfmake";

const FONTS_DIR = resolve(__dirname, "../../assets/fonts");

beforeAll(() => {
  registerPdfFonts(
    Object.fromEntries(
      Object.values(RALEWAY_FILES).map((name) => [
        name,
        readFileSync(resolve(FONTS_DIR, name)),
      ]),
    ) as Record<RalewayFile, Buffer>,
  );
});

const blocks: Block[] = [
  {
    id: "form1",
    type: "formula",
    text: "IFBAP_{c,t} = \\left[0{,}4 \\cdot \\frac{FBA_{c,t}}{PIB_{c,t}}\\right] \\times 100",
    marks: [],
  },
  {
    id: "para1",
    type: "paragraph",
    text: "Donde FBA_{c,t} es la financiación basal.",
    marks: [{ type: "formula", from: 6, to: 15 }],
  },
  { id: "form2", type: "formula", text: "\\frac{1}{", marks: [] },
];

describe("formulas in the PDF", () => {
  it("draws a displayed formula as SVG, sized in points", () => {
    const drawn = formulaSvg("\\frac{a}{b}");
    expect(drawn?.svg).toMatch(/^<svg[\s>]/);
    expect(drawn?.svg).not.toContain("currentColor");
    expect(drawn!.width).toBeGreaterThan(0);
    expect(formulaSvg("\\frac{1}{")).toBeNull();
  });

  it("lays the formulas out, the broken one as text", async () => {
    const content = blocksToPdf(blocks, { links: new LinkRegistry() });
    const json = JSON.stringify(content);
    expect(json).toContain('"svg":"<svg');
    // The formula in the sentence: its subscript lowered.
    expect(json).toContain('{"text":"c,t","italics":true,"sub":true}');
    const buffer = await pdfmake
      .createPdf({ content, defaultStyle: { font: "Raleway" } })
      .getBuffer();
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("formulas in Word", () => {
  it("writes formulas as native Word equations", async () => {
    expect(formulaToDocx("\\frac{1}{", true)).toBeNull();
    const buffer = await buildDocumentDocx({
      title: "Resolución",
      assemblyLabel: "80.ª AGO",
      pageCount: "{page} de {total}",
      blocks,
    });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml.match(/<m:oMath>/g)).toHaveLength(2);
    expect(xml).toContain("<m:f>");
    expect(xml).toContain("<m:sSub>");
    expect(xml).toContain("<m:d>");
    // The one that does not parse is still there, as text.
    expect(xml).toContain("1/");
  });
});

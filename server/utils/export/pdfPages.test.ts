import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create as createFont } from "fontkit";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import type { Block } from "../../../shared/types/content";
import { BRAND_FILES, type ExportBrand } from "./brand";
import { buildPageMap } from "./pageMap";
import {
  buildDocumentPdf,
  type ExportAssembly,
  type ExportDocumentMeta,
} from "./pdfBuilder";
import { PDF_FONT_FILES, type RalewayFile } from "./pdfmake";
import { renderPdf, renderPdfBatch } from "./pdfRender";

/**
 * The pages of a text's clean PDF, read back from the render process
 * (pageMap.ts), checked against the PDF itself: each page's text as pdf.js
 * reads it. In a file of its own, since it spawns render processes
 * (AGENTS.md, Verification Checklist).
 */

const RENDER_TEST_TIMEOUT = 180_000;
const FONTS_DIR = resolve(__dirname, "../../assets/fonts");
const ASSETS_DIR = resolve(__dirname, "../../assets");

const fonts = Object.fromEntries(
  PDF_FONT_FILES.map((name) => [name, readFileSync(resolve(FONTS_DIR, name))]),
) as Record<RalewayFile, Buffer>;

const brand: ExportBrand = {
  creupLogoPng: readFileSync(resolve(ASSETS_DIR, BRAND_FILES.creupLogo)),
  esuLogoPng: readFileSync(resolve(ASSETS_DIR, BRAND_FILES.esuLogo)),
  labelFont: createFont(readFileSync(resolve(FONTS_DIR, "Raleway-Bold.woff"))),
};

const assembly: ExportAssembly = {
  label: "80.ª AGO",
  number: 80,
  type: "AGO",
  startDate: new Date("2026-11-20T09:00:00Z"),
  endDate: new Date("2026-11-22T14:00:00Z"),
  location: "Universidad de Murcia",
};

const meta: ExportDocumentMeta = {
  title: "Reglamento de prueba",
  reference: null,
  kind: "regulation",
  format: "structured",
  proponent: null,
  fileName: null,
  agendaNumbering: null,
  agendaTitle: null,
  finalVote: null,
};

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

/** A cell's only block: row `row`, column `column` of the table. */
const cell = (
  id: string,
  text: string,
  row: number,
  column: number,
  header = false,
): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
  cell: {
    table: "t1",
    row: `row${row}`,
    cell: `cell${row}-${column}`,
    ...(header ? { header: true } : {}),
  },
});

/**
 * A text of some twelve pages: headings of every level (kept with the text
 * after them), paragraphs that break across pages, a list, and a long table
 * with a header row repeated on every page.
 */
function fixture(): Block[] {
  const blocks: Block[] = [];
  for (let article = 1; article <= 14; article += 1) {
    blocks.push({
      id: `h${article}`,
      type: "heading",
      level: (article % 3) + 1,
      text: `Art${article}tit. Sección`,
      marks: [],
    });
    blocks.push(
      p(
        `p${article}`,
        `Apartado${article}primero. ${"Texto del apartado que ocupa varias líneas. ".repeat(article % 4 === 0 ? 60 : 12)}`,
      ),
    );
    if (article === 5) {
      for (let item = 1; item <= 6; item += 1) {
        blocks.push({
          id: `l${item}`,
          type: "list_item",
          level: 0,
          list: "ordered",
          text: `Elemento${item} de la lista.`,
          marks: [],
        });
      }
    }
    if (article === 8) {
      blocks.push(cell("th1", "Concepto", 0, 0, true));
      blocks.push(cell("th2", "Importe", 0, 1, true));
      for (let row = 1; row <= 60; row += 1) {
        blocks.push(cell(`r${row}a`, `F${row}fila concepto`, row, 0));
        blocks.push(cell(`r${row}b`, `Imp${row}e euros`, row, 1));
      }
    }
  }
  return blocks;
}

/** Each page's text as pdf.js reads it, spaces collapsed. */
async function pageTexts(pdf: Buffer): Promise<string[]> {
  const document = await getDocument({
    data: new Uint8Array(pdf),
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
  const texts: string[] = [];
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    texts.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " "),
    );
  }
  await document.destroy();
  return texts;
}

/** The first word of a block's text, which the fixture keeps unique. */
function firstWord(block: Block): string {
  return block.text.split(" ")[0]!;
}

/** Normalizes what changes from one render to the next (export.test.ts). */
function stable(pdf: Buffer): string {
  return pdf
    .toString("latin1")
    .replace(/\(D:\d{14}Z\)/g, "(D:)")
    .replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/gi, "/ID []");
}

describe("pages of a text's PDF", () => {
  it.each<[string, ExportDocumentMeta["kind"], number]>([
    ["a regulation", "regulation", 0],
    ["a positioning, after its cover", "positioning", 1],
  ])(
    "says where each page of %s starts, as the PDF prints it",
    async (_, kind, firstPage) => {
      const blocks = fixture();
      const build = (pageTags: boolean) =>
        buildDocumentPdf(
          {
            assembly,
            document: { ...meta, kind },
            body: { variant: "clean", source: "base", blocks },
            generatedAt: new Date("2026-11-21T10:00:00Z"),
          },
          "es",
          brand,
          { pageTags },
        );
      const [tagged, plain] = await Promise.all([
        renderPdfBatch([build(true)], fonts, undefined, { pages: true }),
        renderPdf(build(false), fonts),
      ]);
      // The tags change nothing in the PDF (no named destination either).
      expect(stable(tagged.pdfs[0]!)).toBe(stable(plain.pdf));

      const raw = tagged.pages![0]!;
      // Every block was tagged once.
      expect(raw.tags.map(([id]) => id).sort()).toEqual(
        blocks.map((block) => block.id).sort(),
      );
      // A row's cell has its page: its id was kept (the render dropped it
      // only as a named destination), and a header row's has none.
      const tagOf = (id: string) => raw.tags.find(([tagged]) => tagged === id);
      expect(tagOf("r30a")?.[1]).toEqual(expect.any(Number));
      expect(tagOf("th1")?.slice(1)).toEqual([null, null, 1]);
      const texts = await pageTexts(tagged.pdfs[0]!);
      expect(raw.total).toBe(texts.length);

      const map = buildPageMap(
        blocks.map((block) => block.id),
        raw,
        firstPage,
      );
      expect(map.total).toBe(texts.length - firstPage);
      // Some pages start inside a long paragraph, some in the table.
      expect(map.starts.some((start) => start.inside)).toBe(true);
      expect(map.starts.some((start) => start.blockId.startsWith("r"))).toBe(
        true,
      );
      const byId = new Map(blocks.map((block) => [block.id, block]));
      // The cover and the index come first (indexedBody): the index lists
      // the headings, so the text is read from the page it starts on.
      const textStart = map.starts[0]!.page - 1 + firstPage;
      expect(textStart).toBeGreaterThan(firstPage);
      const index = texts.slice(firstPage, textStart).join(" ");
      const firstHeading = blocks.find((block) => block.type === "heading")!;
      expect(index).toContain(firstWord(firstHeading));
      if (kind === "positioning") expect(index).toContain("ÍNDICE");
      let previous = 0;
      for (const start of map.starts) {
        expect(start.page).toBeGreaterThan(previous);
        previous = start.page;
        const page = texts[start.page - 1 + firstPage]!;
        // The footer prints the same number.
        expect(page).toContain(`${start.page} de ${map.total}`);
        const word = firstWord(byId.get(start.blockId)!);
        if (start.inside) {
          // It began on an earlier page.
          const began = texts.findIndex(
            (text, at) => at >= textStart && text.includes(word),
          );
          expect(began).toBeGreaterThanOrEqual(0);
          expect(began).toBeLessThan(start.page - 1 + firstPage);
        } else {
          expect(page).toContain(word);
          // And on no earlier page.
          for (
            let earlier = textStart;
            earlier < start.page - 1 + firstPage;
            earlier++
          )
            expect(texts[earlier]).not.toContain(word);
        }
      }
      // Every printed page holding text has its start; the index's hold
      // none of the text's blocks.
      expect(map.starts.length).toBe(map.total - (textStart - firstPage));
    },
    RENDER_TEST_TIMEOUT,
  );
});

describe("justified text", () => {
  it(
    "breaks the same lines and pages as text aligned to the left",
    async () => {
      const blocks = fixture();
      const build = (justified: boolean) =>
        buildDocumentPdf(
          {
            assembly,
            document: meta,
            body: { variant: "clean", source: "base", blocks },
            generatedAt: new Date("2026-11-21T10:00:00Z"),
          },
          "es",
          brand,
          { pageTags: true, justified },
        );
      const [justified, ragged] = await Promise.all([
        renderPdfBatch([build(true)], fonts, undefined, { pages: true }),
        renderPdfBatch([build(false)], fonts, undefined, { pages: true }),
      ]);
      // The PDFs differ (the spaces), the pages they lay out do not: the
      // page maps of the web text hold for both (pageLayoutKey).
      expect(stable(justified.pdfs[0]!)).not.toBe(stable(ragged.pdfs[0]!));
      expect(justified.pages![0]).toEqual(ragged.pages![0]);
    },
    RENDER_TEST_TIMEOUT,
  );
});

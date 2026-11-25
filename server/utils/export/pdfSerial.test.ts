import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create as createFont } from "fontkit";
import type {
  Content,
  ContentText,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PDF_FONT_FILES,
  RALEWAY_EXT_FILES,
  RALEWAY_FILES,
  pdfmake,
  registerPdfFonts,
  type RalewayFile,
} from "./pdfmake";
import {
  LATIN_EXT,
  PDF_FUNCTIONS_SCRIPT,
  RALEWAY_EXT_FAMILY,
  expandLigatures,
  pdfFunction,
  pdfText,
  serializePdfDefinition,
  type PdfFunctionSpec,
} from "./pdfSerial";

const FONTS_DIR = resolve(__dirname, "../../assets/fonts");

const readFonts = () =>
  Object.fromEntries(
    PDF_FONT_FILES.map((name) => [
      name,
      readFileSync(resolve(FONTS_DIR, name)),
    ]),
  ) as Record<RalewayFile, Buffer>;

/** The code points a bundled font draws (fontkit). */
function characterSet(name: RalewayFile): Set<number> {
  const font = createFont(readFileSync(resolve(FONTS_DIR, name))) as {
    characterSet?: number[];
  };
  return new Set(font.characterSet ?? []);
}

type KeepHeading = (
  node: { headlineLevel?: unknown },
  queries: { getFollowingNodesOnPage(): { style?: unknown }[] },
) => boolean;

/** The render process's copy of `materialize` (pdfRender.ts runs it). */
const scriptMaterialize = new Function(
  `${PDF_FUNCTIONS_SCRIPT}\nreturn materialize;`,
)() as (spec: PdfFunctionSpec) => KeepHeading;

describe("expandLigatures", () => {
  it("spells the ligature characters out in their letters", () => {
    expect(expandLigatures("Ratiﬁcar los ﬁnes")).toBe("Ratificar los fines");
    expect(expandLigatures("ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ")).toBe("ff fi fl ffi ffl st st");
  });

  it("leaves every other compatibility character as it is", () => {
    const text = "1.ª y 2.º · m² · ½ · «Gwosć» — “x”";
    expect(expandLigatures(text)).toBe(text);
  });

  it("is applied to every string of a serialized definition", () => {
    const json = serializePdfDefinition({
      content: [{ text: ["Los ﬁnes", { text: "ﬂuir", bold: true }] }],
      info: { title: "Deﬁnición" },
    });
    expect(json).not.toMatch(/[ﬀ-ﬆ]/);
    expect(json).toContain("Los fines");
    expect(json).toContain("fluir");
    expect(json).toContain("Definición");
  });

  it("covers characters the embedded Raleway has no glyph for", () => {
    for (const name of Object.values(RALEWAY_FILES)) {
      const font = createFont(readFileSync(resolve(FONTS_DIR, name)));
      const hasGlyph = (font as { hasGlyphForCodePoint?: unknown })
        .hasGlyphForCodePoint;
      expect(typeof hasGlyph).toBe("function");
      if (typeof hasGlyph !== "function") continue;
      const covers = (codePoint: number): boolean =>
        Boolean(hasGlyph.call(font, codePoint));
      expect(covers(0xfb01)).toBe(false);
      for (const letter of "filst") {
        expect(covers(letter.codePointAt(0)!)).toBe(true);
      }
    }
  });
});

describe("the latin-ext cut of Raleway", () => {
  const routed = (codePoint: number) =>
    LATIN_EXT.test(String.fromCodePoint(codePoint));

  it("draws exactly what the serializer sends it", () => {
    for (const style of Object.keys(
      RALEWAY_FILES,
    ) as (keyof typeof RALEWAY_FILES)[]) {
      const main = characterSet(RALEWAY_FILES[style]);
      const ext = characterSet(RALEWAY_EXT_FILES[style]);
      expect(main.size).toBeGreaterThan(200);
      for (const codePoint of ext) {
        if (!main.has(codePoint)) expect(routed(codePoint)).toBe(true);
      }
      for (const codePoint of main) expect(routed(codePoint)).toBe(false);
      // Letters of the assemblies' texts: each has a glyph in the font it
      // goes to. Raleway has no ≥, ≤ or →: they are left out.
      for (const letter of "ćłőčšžŁĆŞğřŕ€ªº½«»ñçÑÇ–—…‘’“”·×") {
        const codePoint = letter.codePointAt(0)!;
        expect((routed(codePoint) ? ext : main).has(codePoint)).toBe(true);
      }
    }
  });

  it("spells the hyphens Raleway lacks as the hyphen-minus", () => {
    // The non-breaking one too, which then may wrap (accepted: pdfText).
    expect(pdfText("co\u2010presentador y 2026\u2011\ufb01n")).toBe(
      "co-presentador y 2026-fin",
    );
  });

  it("puts those letters in RalewayExt and leaves the rest alone", () => {
    const definition = JSON.parse(
      serializePdfDefinition({
        content: [
          { text: "Gwosć", style: "p" },
          {
            text: [
              "Los ",
              { text: "Łódź y Kraków", bold: true, id: "anchor" },
              "Lublin",
            ],
          },
          "Gdańsk",
          "Kraków",
          { table: { body: [["č"]] } },
          { text: "Sin cambios" },
        ],
        info: { title: "Łódź" },
      }),
    ) as { content: unknown[]; info: { title: string } };
    const ext = (text: string) => ({ text, font: RALEWAY_EXT_FAMILY });
    expect(definition.content).toEqual([
      { text: ["Gwos", ext("ć")], style: "p" },
      {
        // An inline keeps its properties in every run; the id goes once.
        text: [
          "Los ",
          { id: "anchor", bold: true, ...ext("Ł") },
          { bold: true, text: "ód" },
          { bold: true, ...ext("ź") },
          { bold: true, text: " y Kraków" },
          "Lublin",
        ],
      },
      // A bare string where a node goes becomes a node; ó is Latin-1.
      { text: ["Gda", ext("ń"), "sk"] },
      "Kraków",
      { table: { body: [[{ text: [ext("č")] }]] } },
      { text: "Sin cambios" },
    ]);
    expect(definition.info.title).toBe("Łódź");
  });

  it("lays out a text that mixes both", async () => {
    registerPdfFonts(readFonts());
    const definition = JSON.parse(
      serializePdfDefinition({
        content: [{ text: "Gwosć y Łódź", bold: true }],
        defaultStyle: { font: "Raleway" },
      }),
    ) as TDocumentDefinitions;
    const pdf = await pdfmake.createPdf(definition).getBuffer();
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("keepHeadingWithNext", () => {
  const spec: PdfFunctionSpec = { kind: "keepHeadingWithNext" };
  const copies: [string, KeepHeading][] = [
    ["here", pdfFunction<KeepHeading>(spec)],
    ["in the render process", scriptMaterialize(spec)],
  ];
  const following = (nodes: { style?: unknown }[]) => ({
    getFollowingNodesOnPage: () => nodes,
  });

  it.each(copies)("moves a heading last on its page (%s)", (_, keep) => {
    expect(keep({ headlineLevel: 2 }, following([]))).toBe(true);
    // A framed heading's own cell follows it.
    expect(
      keep({ headlineLevel: 1 }, following([{ style: "barHeading" }])),
    ).toBe(true);
    expect(
      keep({ headlineLevel: 3 }, following([{ style: "boxHeading" }])),
    ).toBe(true);
  });

  it.each(copies)("leaves a heading with text after it (%s)", (_, keep) => {
    expect(
      keep({ headlineLevel: 1 }, following([{ style: "barHeading" }, {}])),
    ).toBe(false);
    expect(keep({ headlineLevel: 2 }, following([{}]))).toBe(false);
    expect(keep({}, following([]))).toBe(false);
  });
});

describe("a framed heading at the foot of a page", () => {
  beforeAll(() => {
    registerPdfFonts(readFonts());
  });

  /**
   * A 200 pt high page whose filler leaves room for the bar heading but not
   * for the paragraph after it. Answers the pages of the heading's text and
   * of the paragraph once laid out.
   */
  async function layOut(keep: boolean): Promise<[number, number]> {
    const cell: ContentText = { text: "Artículo 1", style: "barHeading" };
    const paragraph: ContentText = {
      text: "Texto del artículo.",
      margin: [0, 30, 0, 0],
    };
    const definition: TDocumentDefinitions = {
      pageSize: { width: 300, height: 200 },
      pageMargins: 20,
      defaultStyle: { font: "Raleway" },
      styles: { barHeading: { fontSize: 15, bold: true, lineHeight: 1 } },
      content: [
        { canvas: [{ type: "rect", x: 0, y: 0, w: 10, h: 125 }] },
        {
          table: { widths: ["*"], body: [[cell]] },
          headlineLevel: 1,
        } as Content,
        paragraph,
      ],
      ...(keep
        ? {
            pageBreakBefore: pdfFunction<
              NonNullable<TDocumentDefinitions["pageBreakBefore"]>
            >({ kind: "keepHeadingWithNext" }),
          }
        : {}),
    };
    await pdfmake.createPdf(definition).getBuffer();
    const pageOf = (node: object) =>
      (node as { positions: { pageNumber: number }[] }).positions[0]!
        .pageNumber;
    return [pageOf(cell), pageOf(paragraph)];
  }

  it("moves to the next page with the text it heads", async () => {
    // Without the rule the bar is left alone at the foot of page 1.
    expect(await layOut(false)).toEqual([1, 2]);
    expect(await layOut(true)).toEqual([2, 2]);
  });
});

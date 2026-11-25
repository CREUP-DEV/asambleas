import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { describe, expect, it } from "vitest";
import {
  installWordJustify,
  wordJustifyShifts,
  type JustifiedInline,
} from "./pdfJustify";
import {
  PDF_FONT_FILES,
  pdfmake,
  registerPdfFonts,
  type RalewayFile,
} from "./pdfmake";
import { serializePdfDefinition } from "./pdfSerial";

const FONTS_DIR = resolve(__dirname, "../../assets/fonts");

/** The copies the render process gets (pdfRender.ts embeds them as source). */
const scriptCopies = new Function(
  `const wordJustifyShifts = ${wordJustifyShifts.toString()};\n` +
    `const installWordJustify = ${installWordJustify.toString()};\n` +
    "return { wordJustifyShifts, installWordJustify };",
)() as {
  wordJustifyShifts: typeof wordJustifyShifts;
  installWordJustify: typeof installWordJustify;
};

describe("wordJustifyShifts", () => {
  const copies: [string, typeof wordJustifyShifts][] = [
    ["here", wordJustifyShifts],
    ["in the render process", scriptCopies.wordJustifyShifts],
  ];

  it.each(copies)(
    "spreads the space over the gaps between words (%s)",
    (_, shifts) => {
      // «Ir a Gda|ń|sk hoy»: five inlines, three gaps between words.
      const inlines: JustifiedInline[] = [
        {},
        {},
        { noNewLine: true },
        { noNewLine: true },
        {},
        {},
      ];
      expect(shifts(inlines, 30)).toEqual({
        offsets: [0, 10, 20, 20, 20, 30],
        gaps: [0, 10, 10, 0, 0, 10],
      });
    },
  );

  it.each(copies)(
    "leaves a line alone with nothing to spread (%s)",
    (_, shifts) => {
      expect(shifts([{}, {}], 0)).toBeNull();
      expect(shifts([{}], 12)).toBeNull();
      // One word in pieces: no gap to open.
      expect(
        shifts([{ noNewLine: true }, { noNewLine: true }, {}], 12),
      ).toBeNull();
    },
  );
});

describe("installWordJustify", () => {
  it("refuses what is not pdfmake's writer", () => {
    expect(installWordJustify(null, wordJustifyShifts)).toBe(false);
    // A function without alignLine on its prototype.
    expect(installWordJustify(() => undefined, wordJustifyShifts)).toBe(false);
    expect(scriptCopies.installWordJustify({}, wordJustifyShifts)).toBe(false);
  });

  it("opens no space inside a word that changes font in a justified line", async () => {
    registerPdfFonts(
      Object.fromEntries(
        PDF_FONT_FILES.map((name) => [
          name,
          readFileSync(resolve(FONTS_DIR, name)),
        ]),
      ) as Record<RalewayFile, Buffer>,
    );
    const load = createRequire(import.meta.url);
    const loaded = load(
      join(dirname(load.resolve("pdfmake")), "ElementWriter.js"),
    ) as { default?: { prototype: { alignLine: (line: unknown) => void } } };
    const proto = (loaded.default ?? loaded) as unknown as {
      prototype: { alignLine: (line: unknown) => void; wordJustify?: boolean };
    };
    expect(proto.prototype.wordJustify).toBe(true);

    type Line = {
      inlines: { text: string; noNewLine?: boolean; justifyShift?: number }[];
    };
    const lines: Line[] = [];
    const patched = proto.prototype.alignLine;
    proto.prototype.alignLine = function (this: unknown, line: unknown) {
      patched.call(this, line);
      lines.push(line as Line);
    };
    try {
      // As the export sends it: Łódź and Gdańsk in pieces, Raleway and its
      // latin-ext cut (pdfSerial.ts), justified over several lines.
      const definition = JSON.parse(
        serializePdfDefinition({
          pageSize: { width: 300, height: 800 },
          pageMargins: 20,
          defaultStyle: { font: "Raleway" },
          content: [
            {
              text: "Las sedes de Łódź y de Gdańsk acogen la reunión del consejo. ".repeat(
                6,
              ),
              alignment: "justify",
            },
          ],
        }),
      ) as TDocumentDefinitions;
      await pdfmake.createPdf(definition).getBuffer();
    } finally {
      proto.prototype.alignLine = patched;
    }

    const justified = lines.filter((line) =>
      line.inlines.some((inline) => (inline.justifyShift ?? 0) > 0),
    );
    expect(justified.length).toBeGreaterThan(1);
    let pieces = 0;
    for (const line of lines) {
      line.inlines.forEach((inline, index) => {
        if (index > 0 && line.inlines[index - 1]!.noNewLine) {
          pieces += 1;
          expect(inline.justifyShift ?? 0).toBe(0);
        }
      });
    }
    // «Ł|ódź», «Gda|ń|sk» and «ód|ź» on every line that has them.
    expect(pieces).toBeGreaterThan(0);
  });
});

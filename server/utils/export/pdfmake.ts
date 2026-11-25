import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as pdfmakeModule from "pdfmake";
import type { TFontDictionary } from "pdfmake/interfaces";
import { RALEWAY_EXT_FAMILY } from "./pdfSerial";
import { installWordJustify, wordJustifyShifts } from "./pdfJustify";

type PdfMake = typeof pdfmakeModule;

/** pdfmake's in-memory file system; not part of its published types. */
interface VirtualFileSystem {
  existsSync(filename: string): boolean;
  writeFileSync(filename: string, content: Buffer): void;
}

// pdfmake 0.3 exports a CommonJS singleton whose methods live on its
// prototype, so the namespace object only carries them under `default`.
export const pdfmake: PdfMake =
  (pdfmakeModule as unknown as { default?: PdfMake }).default ?? pdfmakeModule;

/**
 * Raleway files bundled in server/assets/fonts: the latin subset the
 * interface serves too (@fontsource/raleway's latin files).
 */
export const RALEWAY_FILES = {
  normal: "Raleway-Regular.woff",
  bold: "Raleway-Bold.woff",
  italics: "Raleway-Italic.woff",
  bolditalics: "Raleway-BoldItalic.woff",
} as const;

/**
 * Raleway's latin-ext cut (@fontsource/raleway's latin-ext files), bundled
 * next to it: the letters the latin subset lacks, which the serializer puts
 * in this family (pdfSerial.ts, RALEWAY_EXT_FAMILY).
 */
export const RALEWAY_EXT_FILES = {
  normal: "RalewayExt-Regular.woff",
  bold: "RalewayExt-Bold.woff",
  italics: "RalewayExt-Italic.woff",
  bolditalics: "RalewayExt-BoldItalic.woff",
} as const;

/** The font families every PDF is laid out with. */
export const PDF_FONT_FAMILIES = {
  Raleway: RALEWAY_FILES,
  [RALEWAY_EXT_FAMILY]: RALEWAY_EXT_FILES,
} as const;

/** Every font file the PDF families use. */
export const PDF_FONT_FILES = [
  ...Object.values(RALEWAY_FILES),
  ...Object.values(RALEWAY_EXT_FILES),
] as const;

export type RalewayFile = (typeof PDF_FONT_FILES)[number];

/** PDF_FONT_FAMILIES as pdfmake's `setFonts` takes it (fresh copies). */
export function pdfFontFamilies(): TFontDictionary {
  return Object.fromEntries(
    Object.entries(PDF_FONT_FAMILIES).map(([family, files]) => [
      family,
      { ...files },
    ]),
  );
}

/**
 * Installs word-only justification (pdfJustify.ts) in this process's
 * pdfmake, as the render process does: the same definition lays out the
 * same here and there. False when pdfmake's writer is not where expected.
 */
export function installPdfLayoutPatches(): boolean {
  try {
    const load = createRequire(import.meta.url);
    const loaded = load(
      join(dirname(load.resolve("pdfmake")), "ElementWriter.js"),
    ) as { default?: unknown };
    return installWordJustify(loaded.default ?? loaded, wordJustifyShifts);
  } catch {
    return false;
  }
}

/**
 * Registers the PDF fonts (PDF_FONT_FAMILIES) and locks resource access
 * down, in this process (the tests), with the layout patches
 * (installPdfLayoutPatches). The app never lays a PDF out here: the render
 * process does it (pdfRender.ts) and registers the fonts and the patches the
 * same way.
 *
 * pdfmake 0.3 reads an object font source as `{ url, headers }` and then
 * overwrites it, so a Buffer passed to `setFonts` breaks the first render.
 * The font data goes into pdfmake's virtual file system instead and the
 * fonts are referenced by file name, which it resolves there before any
 * local path. Remote URLs and local files stay forbidden.
 */
export function registerPdfFonts(files: Record<RalewayFile, Buffer>): void {
  installPdfLayoutPatches();
  const vfs = (pdfmake as unknown as { virtualfs: VirtualFileSystem })
    .virtualfs;
  for (const name of PDF_FONT_FILES) {
    vfs.writeFileSync(name, files[name]);
  }
  pdfmake.setFonts(pdfFontFamilies());
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
}

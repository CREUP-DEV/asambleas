import * as pdfmakeModule from "pdfmake";

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

/** Raleway files bundled in server/assets/fonts. */
export const RALEWAY_FILES = {
  normal: "Raleway-Regular.woff",
  bold: "Raleway-Bold.woff",
  italics: "Raleway-Italic.woff",
  bolditalics: "Raleway-BoldItalic.woff",
} as const;

export type RalewayFile = (typeof RALEWAY_FILES)[keyof typeof RALEWAY_FILES];

/**
 * Registers Raleway and locks resource access down.
 *
 * pdfmake 0.3 reads an object font source as `{ url, headers }` and then
 * overwrites it, so a Buffer passed to `setFonts` breaks the first render.
 * The font data goes into pdfmake's virtual file system instead and the
 * fonts are referenced by file name, which it resolves there before any
 * local path. Remote URLs and local files stay forbidden.
 */
export function registerPdfFonts(files: Record<RalewayFile, Buffer>): void {
  const vfs = (pdfmake as unknown as { virtualfs: VirtualFileSystem })
    .virtualfs;
  for (const name of Object.values(RALEWAY_FILES)) {
    vfs.writeFileSync(name, files[name]);
  }
  pdfmake.setFonts({ Raleway: { ...RALEWAY_FILES } });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
}

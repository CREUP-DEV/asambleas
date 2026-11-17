import { create as createFont } from "fontkit";
import { BRAND_FILES, type ExportBrand } from "./brand";
import { RALEWAY_FILES, type RalewayFile } from "./pdfmake";

/**
 * The files every export lays out with: Raleway for the render process and
 * the letterhead's logos, read once from the server's bundled assets (a
 * build has no files on disk to read them from).
 */

let fonts: Record<RalewayFile, Buffer> | null = null;
let brand: ExportBrand | null = null;

async function readServerAsset(path: string): Promise<Buffer> {
  const raw = await useStorage("assets:server").getItemRaw(path);
  if (!raw) {
    throw new Error(`PDF asset not found: ${path}`);
  }
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
}

function readServerFont(name: RalewayFile): Promise<Buffer> {
  return readServerAsset(`fonts/${name}`);
}

/** The letterhead's logos, read once like the fonts. */
export async function loadBrand(): Promise<ExportBrand> {
  if (brand) return brand;
  const [creupLogo, esuLogo, bold] = await Promise.all([
    readServerAsset(BRAND_FILES.creupLogo),
    readServerAsset(BRAND_FILES.esuLogo),
    readServerFont(RALEWAY_FILES.bold),
  ]);
  brand = {
    creupLogoPng: creupLogo,
    esuLogoPng: esuLogo,
    labelFont: createFont(bold),
  };
  return brand;
}

/** Raleway for the render process, read once. */
export async function loadPdfFonts(): Promise<Record<RalewayFile, Buffer>> {
  if (fonts) return fonts;
  const names = Object.values(RALEWAY_FILES);
  const buffers = await Promise.all(names.map(readServerFont));
  fonts = Object.fromEntries(
    names.map((name, i) => [name, buffers[i]!]),
  ) as Record<RalewayFile, Buffer>;
  return fonts;
}

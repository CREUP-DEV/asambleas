/**
 * CREUP's letterhead for PDF exports, after the template of its documents
 * (Google Docs, A4): the CREUP logo top left, the ESU logo top right, a
 * burgundy band down the left edge labelled "Documentación interna", and the
 * website and email centred in the footer with the page count on the right.
 * Positions and sizes are the template's, in points.
 */

import type { Font } from "fontkit";
import type { DocumentKind } from "../../../shared/constants/domain";

/** Files bundled in server/assets, read by the export worker. */
export const BRAND_FILES = {
  creupLogo: "brand/creup-logo.png",
  esuLogo: "brand/esu-logo.png",
} as const;

export interface ExportBrand {
  /**
   * The CREUP and ESU logos, PNGs taken from the template. pdfmake embeds an
   * image once for every page; an SVG logo it would draw again on each,
   * about 85 KB a page for CREUP's.
   */
  creupLogoPng: Buffer;
  esuLogoPng: Buffer;
  /** Raleway Bold, opened with fontkit, to draw the band's label. */
  labelFont: Font;
}

export const BRAND_RED = "#792225";

/** A4 in points, as pdfmake lays it out. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

/** The template's margins: left, top, right, bottom. */
export const TEMPLATE_MARGINS: [number, number, number, number] = [
  85, 92.1, 85.6, 69.7,
];

/**
 * The CREUP logo is cropped to its drawing (rendered from public/marca at
 * 1800 px), so it sits where the drawing does in the template's padded one.
 */
export const LOGOS = {
  creup: { x: 69.4, y: 36.7, width: 129 },
  esu: { x: 452.5, y: 37, width: 92.3 },
} as const;

/** The positioning cover: logo, rule and contact band, from the top. */
export const COVER = {
  logo: { y: 576, width: 292 },
  rule: { y: 689, width: 2.7 },
  band: { y: 733, height: 27 },
} as const;

/** Label keys (`export.pdf.band.*`) for the band, by document kind. */
const BAND_LABELS: Partial<Record<DocumentKind, string>> = {
  internal_motion: "internalMotion",
  regulation: "ownRegulations",
  statutes: "ownRegulations",
  positioning: "positioning",
  resolution: "resolution",
};

/** What the band says: the kind of document, or "internal document". */
export function bandLabelKey(kind: DocumentKind): string {
  return BAND_LABELS[kind] ?? "internalDocument";
}

/** Positionings open with a cover page. */
export function hasCover(kind: DocumentKind): boolean {
  return kind === "positioning";
}

/** The band: its left edge, top and width; it runs off the bottom. */
const BAND = { x: 26.8, y: 373.4, width: 30 } as const;

export const CONTACT = {
  web: { text: "www.creup.es", href: "https://www.creup.es/" },
  email: { text: "info@creup.es", href: "mailto:info@creup.es" },
} as const;

/** Glyph outlines of `text` at `size` points, baseline at y 0, and its width. */
function textOutline(
  font: Font,
  text: string,
  size: number,
): { d: string; width: number } {
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  let x = 0;
  const parts: string[] = [];
  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index]!;
    // Font units point up; SVG's y points down.
    parts.push(
      glyph.path
        .scale(scale, -scale)
        .translate(x + position.xOffset * scale, -position.yOffset * scale)
        .toSVG(),
    );
    x += position.xAdvance * scale;
  });
  return { d: parts.join(" "), width: x };
}

/**
 * The draft watermark ("BORRADOR") across the page as SVG glyph outlines,
 * not text: as text, its rotated box covers the whole page, so selecting
 * the text around it highlights a huge block, and copying or reading the
 * page aloud picks the word up on every page. Diagonal like pdfmake's own
 * watermark, three quarters of the diagonal long, faint burgundy.
 */
export function watermarkSvg(label: string, font: Font): string {
  const diagonal = Math.hypot(PAGE_WIDTH, PAGE_HEIGHT);
  const angle = (-Math.atan2(PAGE_HEIGHT, PAGE_WIDTH) * 180) / Math.PI;
  const unit = textOutline(font, label, 100);
  const size = (100 * diagonal * 0.75) / unit.width;
  const outline = textOutline(font, label, size);
  // Raleway's capitals rise about 0.71 em above the baseline.
  const lift = (size * 0.71) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">` +
    `<path transform="translate(${(PAGE_WIDTH / 2).toFixed(2)} ${(PAGE_HEIGHT / 2).toFixed(2)}) rotate(${angle.toFixed(3)}) translate(${(-outline.width / 2).toFixed(2)} ${lift.toFixed(2)})" fill="${BRAND_RED}" fill-opacity="0.07" d="${outline.d}"/>` +
    `</svg>`
  );
}

/**
 * The band as SVG, with its label written bottom to top in white Raleway
 * Bold 14 pt, ending just below the rounded top. The label is drawn as glyph
 * outlines: pdfmake's SVG text cannot reach fonts registered in its virtual
 * file system. Without `font` the band has no label.
 */
export function bandSvg(
  label: string,
  font?: Font,
): {
  svg: string;
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const height = PAGE_HEIGHT - BAND.y;
  let text = "";
  if (font) {
    const outline = textOutline(font, label, 14);
    // Rotated a quarter turn back, the baseline runs up the band 21.5 pt
    // from its left edge, and the label ends 11 pt below its top.
    text = `<path transform="translate(21.5 11) rotate(-90) translate(${(-outline.width).toFixed(2)} 0)" fill="#ffffff" d="${outline.d}"/>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAND.width}" height="${height.toFixed(2)}" viewBox="0 0 ${BAND.width} ${height.toFixed(2)}">` +
    // Taller than the page, so only the top corners show rounded.
    `<rect x="0" y="0" width="${BAND.width}" height="${(height + 8).toFixed(2)}" rx="4" ry="4" fill="${BRAND_RED}"/>` +
    text +
    `</svg>`;
  return { svg, x: BAND.x, y: BAND.y, width: BAND.width, height };
}

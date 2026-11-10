/**
 * The fills a table cell may take: CREUP's palette, by name. Content stores
 * the name (`BlockCell.fill`), never a colour code, and the platform picks
 * the text colour that reads on each fill. The editor's swatches, the view's
 * classes (`cx-fill-<name>`, coloured in main.css, which a test keeps equal
 * to this list), the PDF export and the Word import all read this one list.
 */
export const CELL_FILL_NAMES = [
  "burgundy",
  "blue",
  "beige",
  "darkGrey",
  "lightGrey",
  "green",
  "purple",
] as const;

export type CellFillName = (typeof CELL_FILL_NAMES)[number];

/** Text on a fill: white on the dark ones, near-black on the light ones. */
export const CELL_FILL_TEXT = {
  light: "#ffffff",
  dark: "#111111",
} as const;

export interface CellFillColour {
  /** The fill, as `#rrggbb`. */
  hex: string;
  /** Which text colour reads on it (CELL_FILL_TEXT). */
  text: keyof typeof CELL_FILL_TEXT;
}

/** Contrast of the text on each fill (WCAG), all above 5.5:1. */
export const CELL_FILLS: Record<CellFillName, CellFillColour> = {
  burgundy: { hex: "#792225", text: "light" },
  blue: { hex: "#163866", text: "light" },
  beige: { hex: "#f5eee6", text: "dark" },
  darkGrey: { hex: "#424242", text: "light" },
  lightGrey: { hex: "#a6a6a6", text: "dark" },
  green: { hex: "#2a7258", text: "light" },
  purple: { hex: "#513269", text: "light" },
};

export function isCellFillName(value: unknown): value is CellFillName {
  return (
    typeof value === "string" &&
    (CELL_FILL_NAMES as readonly string[]).includes(value)
  );
}

/** The text colour of a fill, as `#rrggbb`. */
export function cellFillTextColour(fill: CellFillName): string {
  return CELL_FILL_TEXT[CELL_FILLS[fill].text];
}

/**
 * The fill of a cell as stored. Content saved before the palette marks its
 * beige cells with `shade: true` (never on a header); it is read as "beige"
 * and stays stored as it is.
 */
export function cellFillOf(cell: {
  fill?: CellFillName;
  shade?: boolean;
  header?: boolean;
}): CellFillName | undefined {
  if (isCellFillName(cell.fill)) return cell.fill;
  return cell.shade === true && !cell.header ? "beige" : undefined;
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  return [0, 2, 4].map((offset) =>
    parseInt(value.slice(offset, offset + 2), 16),
  ) as [number, number, number];
}

/** Below this opacity a pasted background counts as no fill. */
const MIN_FILL_ALPHA = 0.5;

/**
 * A colour as its three channels: `rrggbb` or `rgb`, with or without `#`,
 * or CSS `rgb()` / `rgba()` (pasted cells); null for anything else and for
 * a colour that is mostly transparent (a web table's faint stripes), which
 * is a tint of the page and no fill.
 */
function parseColour(colour: string): [number, number, number] | null {
  const value = colour.trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(value)) return channels(value);
  const short = /^#?([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(value);
  if (short)
    return channels(
      short
        .slice(1, 4)
        .map((c) => c + c)
        .join(""),
    );
  const rgb =
    /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(
      value,
    );
  if (!rgb) return null;
  if (rgb[4] !== undefined) {
    const alpha = parseFloat(rgb[4]) / (rgb[4].endsWith("%") ? 100 : 1);
    if (!(alpha >= MIN_FILL_ALPHA)) return null;
  }
  const parsed = rgb.slice(1, 4).map((part) => Math.min(255, Number(part)));
  return parsed as [number, number, number];
}

/**
 * The palette colour nearest to any colour (see parseColour), by plain RGB
 * distance; null for what is no colour, and for white or nearly so, which
 * is no fill.
 */
export function nearestCellFill(colour: string): CellFillName | null {
  const parsed = parseColour(colour);
  if (!parsed) return null;
  const [r, g, b] = parsed;
  if (Math.min(r, g, b) >= 250) return null;
  let best: CellFillName | null = null;
  let bestDistance = Infinity;
  for (const name of CELL_FILL_NAMES) {
    const [pr, pg, pb] = channels(CELL_FILLS[name].hex);
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

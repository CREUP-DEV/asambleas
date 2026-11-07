import type { Block, ListMarker } from "../../types/content";
import { LIST_MARKERS } from "../../types/content";

/**
 * Ordered lists: their markers ("a)", "IV.") and the shape a list item
 * carries from one copy of a block to another.
 */

/** The block fields that place a block in a list, a table or the outline. */
export type BlockShape = Pick<
  Block,
  "level" | "list" | "marker" | "start" | "cell"
>;

/**
 * Copies `level`, `list`, `marker`, `start` and `cell`, leaving out absent
 * ones. The cell is copied, not shared.
 */
export function copyShape<T extends BlockShape>(from: BlockShape, to: T): T {
  if (from.level !== undefined) to.level = from.level;
  if (from.list !== undefined) to.list = from.list;
  if (from.marker !== undefined) to.marker = from.marker;
  if (from.start !== undefined) to.start = from.start;
  if (from.cell !== undefined) to.cell = { ...from.cell };
  return to;
}

/** The marker an ordered item shows: its own, or "1.". */
export function markerOf(block: Pick<Block, "marker">): ListMarker {
  return block.marker ?? "1.";
}

export function isListMarker(value: unknown): value is ListMarker {
  return (LIST_MARKERS as readonly unknown[]).includes(value);
}

/** Roman numerals up to 3999; past it, digits. */
function roman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const table: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  for (const [value, digits] of table) {
    while (n >= value) {
      out += digits;
      n -= value;
    }
  }
  return out;
}

/** a-z, then aa, bb (as Word and CSS's lower-alpha do not agree, Word's). */
function letters(n: number): string {
  if (n < 1 || n > 26 * 30) return String(n);
  return String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.ceil(n / 26));
}

/** The label of item `n` of a list numbered with `marker`: "3.", "c)", "IV.". */
export function formatListNumber(n: number, marker: ListMarker): string {
  const suffix = marker[1]!;
  switch (marker[0]) {
    case "a":
      return letters(n) + suffix;
    case "A":
      return letters(n).toUpperCase() + suffix;
    case "i":
      return roman(n).toLowerCase() + suffix;
    case "I":
      return roman(n) + suffix;
    default:
      return String(n) + suffix;
  }
}

/**
 * The number each ordered list item shows, the way every renderer groups
 * them: consecutive items of a level with one marker form a list, a deeper
 * item opens a list inside it, any other block ends them all, and an item
 * with `start` starts its level again at that number.
 */
export function orderedListNumbers(
  blocks: Pick<Block, "id" | "type" | "level" | "list" | "marker" | "start">[],
): Map<string, number> {
  const numbers = new Map<string, number>();
  // The open list at each level: its kind, marker and next number.
  const open: { list: string; marker: ListMarker; next: number }[] = [];
  for (const block of blocks) {
    if (block.type !== "list_item") {
      open.length = 0;
      continue;
    }
    const level = Math.max(0, Math.min(6, block.level ?? 0));
    open.length = Math.min(open.length, level + 1);
    const list = block.list ?? "bullet";
    const marker = markerOf(block);
    const current = open[level];
    const continues =
      current !== undefined &&
      current.list === list &&
      current.marker === marker &&
      block.start === undefined;
    const n = continues ? current.next : (block.start ?? 1);
    open[level] = { list, marker, next: n + 1 };
    if (list === "ordered") numbers.set(block.id, n);
  }
  return numbers;
}

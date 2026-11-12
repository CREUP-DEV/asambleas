import type { Block, BlockAlign, ListMarker } from "../../types/content";
import { BLOCK_ALIGNMENTS, LIST_MARKERS } from "../../types/content";

/**
 * Ordered lists: their markers ("a)", "IV.") and the shape a list item
 * carries from one copy of a block to another.
 */

/** The block fields that place a block in a list, a table or the outline. */
export type BlockShape = Pick<
  Block,
  "level" | "list" | "marker" | "start" | "cell" | "align" | "image"
>;

/**
 * Copies `level`, `list`, `marker`, `start`, `cell`, `align` and `image`,
 * leaving out absent ones. The cell and the image are copied, not shared.
 */
export function copyShape<T extends BlockShape>(from: BlockShape, to: T): T {
  if (from.level !== undefined) to.level = from.level;
  if (from.list !== undefined) to.list = from.list;
  if (from.marker !== undefined) to.marker = from.marker;
  if (from.start !== undefined) to.start = from.start;
  if (from.cell !== undefined) to.cell = { ...from.cell };
  if (from.align !== undefined) to.align = from.align;
  if (from.image !== undefined) to.image = { ...from.image };
  return to;
}

/** The marker an ordered item shows: its own, or "1.". */
export function markerOf(block: Pick<Block, "marker">): ListMarker {
  return block.marker ?? "1.";
}

export function isListMarker(value: unknown): value is ListMarker {
  return (LIST_MARKERS as readonly unknown[]).includes(value);
}

export function isBlockAlign(value: unknown): value is BlockAlign {
  return (BLOCK_ALIGNMENTS as readonly unknown[]).includes(value);
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

/** The fields that place a block in a list and number it. */
export type ListBlock = Pick<
  Block,
  "id" | "type" | "level" | "list" | "marker" | "start" | "cell"
>;

/** Where a block sits: the page, or one table cell (a flow of its own). */
function containerOf(block: Pick<Block, "cell">): string {
  return block.cell
    ? JSON.stringify([block.cell.table, block.cell.row, block.cell.cell])
    : "";
}

interface ListWalk<T extends ListBlock> {
  /**
   * False for an ordered item that takes no number (one an amendment
   * deletes, as the diff and the PDF show it): it keeps its place in its
   * list but does not count. One with `start` still starts its level again
   * at that number, which the next counted item of the list then shows.
   */
  counted?: (block: T, index: number) => boolean;
  /**
   * The start a counted ordered item is read with instead of its own.
   * `continued` is the number it would show carrying on the open list
   * (undefined when it opens one); undefined carries the list on.
   */
  startOf?: (
    block: T,
    continued: number | undefined,
    index: number,
  ) => number | undefined;
  /**
   * Called for a counted ordered item that carries on a list whose number
   * an uncounted item with `start` handed on (`n`): without that item, it
   * would need the start itself.
   */
  handedOn?: (block: T, n: number, index: number) => void;
  /**
   * Called for an uncounted ordered item with `next`, the number the next
   * counted item of its list shows after it.
   */
  struck?: (block: T, next: number, index: number) => void;
}

/**
 * Walks list items the way every renderer groups them (renderBlocks, the
 * editor and the PDF): consecutive items of a level with one marker form a
 * list, a deeper item opens a list inside it, any other block or another
 * table cell ends them all, and an item with `start` starts its level again
 * at that number. Returns the number each counted ordered item shows.
 */
function walkLists<T extends ListBlock>(
  blocks: readonly T[],
  walk: ListWalk<T> = {},
): Map<string, number> {
  const numbers = new Map<string, number>();
  // The open list at each level: its kind, marker and next number, and
  // whether an uncounted item set that number with its own start.
  const open: {
    list: string;
    marker: ListMarker;
    next: number;
    handed?: boolean;
  }[] = [];
  let container = "";
  blocks.forEach((block, index) => {
    const here = containerOf(block);
    if (here !== container) {
      open.length = 0;
      container = here;
    }
    if (block.type !== "list_item") {
      open.length = 0;
      return;
    }
    const level = Math.max(0, Math.min(6, block.level ?? 0));
    open.length = Math.min(open.length, level + 1);
    const list = block.list ?? "bullet";
    const marker = markerOf(block);
    const current = open[level];
    const continued =
      current !== undefined &&
      current.list === list &&
      current.marker === marker
        ? current.next
        : undefined;
    const counts = list !== "ordered" || (walk.counted?.(block, index) ?? true);
    if (!counts) {
      // A struck item takes no number. One with `start` still starts its
      // list again there, so the next item that counts shows that number.
      if (block.start !== undefined) {
        open[level] = { list, marker, next: block.start, handed: true };
      } else if (continued === undefined) {
        open[level] = { list, marker, next: 1 };
      }
      walk.struck?.(block, open[level]!.next, index);
      return;
    }
    const start =
      walk.startOf && list === "ordered"
        ? walk.startOf(block, continued, index)
        : block.start;
    const n = start ?? continued ?? 1;
    if (start === undefined && continued !== undefined && current?.handed) {
      walk.handedOn?.(block, n, index);
    }
    open[level] = { list, marker, next: n + 1 };
    if (list === "ordered") numbers.set(block.id, n);
  });
  return numbers;
}

/**
 * The number each ordered list item shows, the way every renderer groups
 * them (see walkLists). Items `counted` leaves out take no number, as the
 * diff and the PDF show the ones an amendment deletes.
 */
export function orderedListNumbers<T extends ListBlock>(
  blocks: readonly T[],
  counted?: (block: T) => boolean,
): Map<string, number> {
  return walkLists(blocks, counted ? { counted } : {});
}

/**
 * For each ordered item `counted` leaves out, the number the next counted
 * item of its list shows after it (see walkLists).
 */
export function struckListNext<T extends ListBlock>(
  blocks: readonly T[],
  counted: (block: T) => boolean,
): Map<string, number> {
  const next = new Map<string, number>();
  walkLists(blocks, {
    counted,
    struck: (block, n) => next.set(block.id, n),
  });
  return next;
}

/**
 * The `start` the blocks `counted` keeps need once the others are gone, so
 * that an uncounted ordered item that started its list again hands its
 * number on (see walkLists): the next counted item of that list with no
 * start of its own takes it, as the diff and the PDF number it. Only where
 * the kept blocks alone would number that item otherwise. Deleting the
 * first item of a list that carries on at "k)" leaves the next one at "k)".
 */
export function handedOnListStarts<T extends ListBlock>(
  blocks: readonly T[],
  counted: (block: T) => boolean,
): Map<string, number> {
  const handed = new Map<string, number>();
  walkLists(blocks, {
    counted,
    handedOn: (block, n) => handed.set(block.id, n),
  });
  const starts = new Map<string, number>();
  if (handed.size === 0) return starts;
  walkLists(
    blocks.filter((block) => counted(block)),
    {
      startOf: (block, continued) => {
        const n = handed.get(block.id);
        if (n === undefined || n === (block.start ?? continued ?? 1)) {
          return block.start;
        }
        starts.set(block.id, n);
        return n;
      },
    },
  );
  return starts;
}

/**
 * The `start` a fragment of a text needs on its ordered items to show the
 * numbers they have in the whole text (`numbers`, from orderedListNumbers):
 * shown alone, a fragment would start every list at 1 or "a)". An item gets
 * one where the fragment would number it otherwise, and so does the first
 * counted ordered item of each run of contiguous blocks (`runStarts`), so
 * a run does not carry on the numbers of the run before it. Items `counted`
 * leaves out keep their own, except one that begins a run: it gets the
 * number the next counted item of its list shows after it in the whole text
 * (`struckNext`, from struckListNext), so it opens a list of its own
 * instead of sitting, with no number, in the list of the run before it.
 */
export function fragmentListStarts<T extends ListBlock>(
  fragment: readonly T[],
  numbers: ReadonlyMap<string, number>,
  options: {
    counted?: (block: T) => boolean;
    /** Indexes in `fragment` where a run of contiguous blocks begins. */
    runStarts?: ReadonlySet<number>;
    /** See struckListNext: for uncounted items that begin a run. */
    struckNext?: ReadonlyMap<string, number>;
  } = {},
): Map<string, number> {
  const starts = new Map<string, number>();
  // The run each block belongs to (-1 without runs).
  const runOf: number[] = [];
  fragment.forEach((_, index) => {
    runOf.push(
      options.runStarts?.has(index) ? index : (runOf[index - 1] ?? -1),
    );
  });
  // Runs whose list is already started again (pinned) at their real number.
  const pinned = new Set<number>();
  const counted = options.counted;
  // A struck ordered item that begins a run opens its list with the number
  // the next counted item shows there.
  const walked = fragment.map((block, index) => {
    if (
      !counted ||
      !options.runStarts?.has(index) ||
      block.type !== "list_item" ||
      block.list !== "ordered" ||
      counted(block)
    ) {
      return block;
    }
    const next = options.struckNext?.get(block.id);
    if (next === undefined) return block;
    starts.set(block.id, next);
    pinned.add(index);
    return { ...block, start: next };
  });
  walkLists(walked, {
    ...(counted ? { counted } : {}),
    startOf: (block, continued, index) => {
      const real = numbers.get(block.id);
      if (real === undefined) return block.start;
      const run = runOf[index]!;
      const firstOfRun = run !== -1 && !pinned.has(run);
      pinned.add(run);
      if (!firstOfRun && real === (block.start ?? continued ?? 1)) {
        return block.start;
      }
      starts.set(block.id, real);
      return real;
    },
  });
  return starts;
}

/**
 * A passage ready for an editor of its own: copies of `blocks` whose
 * ordered items carry, as `start`, the numbers they show after `before`
 * (the blocks before them in the text) wherever the passage alone would
 * number them otherwise, so a passage from "k)" does not start at "a)".
 * diffPassage given the same `before` reads none of them as a change.
 */
export function seedListStarts<T extends ListBlock>(
  before: readonly ListBlock[],
  blocks: readonly T[],
): T[] {
  const numbers = orderedListNumbers<ListBlock>([...before, ...blocks]);
  const starts = fragmentListStarts(blocks, numbers);
  return blocks.map((block) => {
    const start = starts.get(block.id);
    return start === undefined ? block : { ...block, start };
  });
}

/**
 * `blocks` without the `start` that only says the number an item shows
 * anyway after `before` (the blocks before them in the text): the one an
 * editor seeded with a fragment of a list carries, or keeps on the item that
 * becomes first when the author deletes the one that carried it. `stored`
 * keeps the start an item's stored text already gives it.
 */
export function withoutImpliedStarts<T extends ListBlock>(
  before: readonly ListBlock[],
  blocks: readonly T[],
  stored: (block: T) => boolean,
): T[] {
  const offset = before.length;
  const implied = new Set<number>();
  walkLists<ListBlock>([...before, ...blocks], {
    startOf: (block, continued, index) => {
      if (index < offset || block.start === undefined) return block.start;
      const own = blocks[index - offset]!;
      if (block.start !== (continued ?? 1) || stored(own)) return block.start;
      implied.add(index - offset);
      return undefined;
    },
  });
  return blocks.map((block, index) => {
    if (!implied.has(index)) return block;
    const copy: T = { ...block };
    delete copy.start;
    return copy;
  });
}

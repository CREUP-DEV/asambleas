import type {
  Block,
  BlockFormat,
  FormatChange,
  Mark,
  MarkType,
  ReplaceOp,
} from "../../types/content";
import {
  BLOCK_ALIGNMENTS,
  LIST_MARKERS,
  MARK_TYPES,
} from "../../types/content";
import { formatListNumber, markerOf } from "./lists";

/**
 * Formatting an amendment may change on text that is already in the base:
 * the format of a whole block (BlockFormat) and the inline marks of a range.
 * Both travel on replace operations (see ReplaceOp).
 */

// Block format ---------------------------------------------------------------

const FORMAT_TYPES = ["paragraph", "heading", "list_item", "quote"] as const;

/** Whether a value read from an operation has the fields of a BlockFormat. */
export function isValidBlockFormat(value: unknown): value is BlockFormat {
  if (!value || typeof value !== "object") return false;
  const format = value as Record<string, unknown>;
  const integer = (n: unknown, min: number, max: number) =>
    n === undefined ||
    (typeof n === "number" && Number.isInteger(n) && n >= min && n <= max);
  return (
    (FORMAT_TYPES as readonly unknown[]).includes(format.type) &&
    integer(format.level, 0, 6) &&
    (format.list === undefined ||
      format.list === "bullet" ||
      format.list === "ordered") &&
    (format.marker === undefined ||
      (LIST_MARKERS as readonly unknown[]).includes(format.marker)) &&
    integer(format.start, 0, 99_999) &&
    (format.align === undefined ||
      (BLOCK_ALIGNMENTS as readonly unknown[]).includes(format.align))
  );
}

/**
 * A format with only the fields its type keeps, as the block schema stores
 * them: a heading has a level, a list item a level and a kind, an ordered
 * item its marker (unless "1.") and its start.
 */
export function normalizeBlockFormat(format: BlockFormat): BlockFormat {
  const result: BlockFormat = { type: format.type };
  if (format.type === "heading") result.level = format.level ?? 1;
  if (format.type === "list_item") {
    result.level = format.level ?? 0;
    result.list = format.list ?? "bullet";
    if (result.list === "ordered") {
      if (format.marker !== undefined && format.marker !== "1.") {
        result.marker = format.marker;
      }
      if (format.start !== undefined) result.start = format.start;
    }
  }
  if (format.align) result.align = format.align;
  return result;
}

type Formatted = Pick<
  Block,
  "type" | "level" | "list" | "marker" | "start" | "align"
>;

/** The format of a block; null for an image, which has none to amend. */
export function blockFormatOf(block: Formatted): BlockFormat | null {
  if (block.type === "image") return null;
  return normalizeBlockFormat({
    type: block.type,
    level: block.level,
    list: block.list,
    marker: block.marker,
    start: block.start,
    align: block.align,
  });
}

export function sameBlockFormat(a: BlockFormat, b: BlockFormat): boolean {
  const x = normalizeBlockFormat(a);
  const y = normalizeBlockFormat(b);
  return (
    x.type === y.type &&
    x.level === y.level &&
    x.list === y.list &&
    x.marker === y.marker &&
    x.start === y.start &&
    x.align === y.align
  );
}

/** What a block becomes, as one word: its type, heading level or list kind. */
function kindKey(format: BlockFormat): string {
  if (format.type === "heading") return `heading:${format.level}`;
  if (format.type === "list_item") return `list:${format.list}`;
  return format.type;
}

/** What changes between two block formats, for the label of the change. */
export function blockFormatChanges(
  base: BlockFormat,
  next: BlockFormat,
): FormatChange[] {
  const from = normalizeBlockFormat(base);
  const to = normalizeBlockFormat(next);
  const changes: FormatChange[] = [];
  if (kindKey(from) !== kindKey(to)) {
    if (to.type === "heading") {
      changes.push({ code: "heading", value: to.level ?? 1 });
    } else if (to.type === "list_item") {
      changes.push({
        code: to.list === "ordered" ? "ordered_list" : "bullet_list",
      });
    } else {
      changes.push({ code: to.type });
    }
  }
  if (to.type === "list_item") {
    const wasItem = from.type === "list_item";
    const level = to.level ?? 0;
    if (wasItem ? (from.level ?? 0) !== level : level > 0) {
      changes.push({ code: "list_level", value: level + 1 });
    }
    if (to.list === "ordered") {
      const wasOrdered = wasItem && from.list === "ordered";
      const marker = markerOf(to);
      if (marker !== (wasOrdered ? markerOf(from) : "1.")) {
        changes.push({
          code: "list_marker",
          value: formatListNumber(1, marker),
        });
      }
      if (to.start !== (wasOrdered ? from.start : undefined)) {
        changes.push(
          to.start === undefined
            ? { code: "list_continue" }
            : { code: "list_start", value: to.start },
        );
      }
    }
  }
  if (from.align !== to.align) {
    changes.push({ code: `align_${to.align ?? "start"}` });
  }
  return changes;
}

// Inline marks ---------------------------------------------------------------

/**
 * The formatting of every character of a text: for each mark type (in
 * MARK_TYPES order), null where the text does not have it and a string where
 * it does (the address for a link, "" otherwise).
 */
export type MarkCoverage = (string | null)[][];

export function markCoverage(marks: Mark[], length: number): MarkCoverage {
  const coverage: MarkCoverage = MARK_TYPES.map(() =>
    new Array<string | null>(length).fill(null),
  );
  for (const mark of marks) {
    const row = coverage[MARK_TYPES.indexOf(mark.type)];
    if (!row) continue;
    const value = mark.type === "link" ? (mark.href ?? "") : "";
    const to = Math.min(length, mark.to);
    for (let i = Math.max(0, mark.from); i < to; i += 1) row[i] = value;
  }
  return coverage;
}

/** Whether character `i` of `a` and character `j` of `b` are formatted alike. */
export function sameFormatAt(
  a: MarkCoverage,
  i: number,
  b: MarkCoverage,
  j: number,
): boolean {
  return a.every((row, type) => row[i] === b[type]![j]);
}

/**
 * The marks of [from, to) of a coverage, with offsets from `from`: one mark
 * per run of each type, ordered by where they start.
 */
export function coverageToMarks(
  coverage: MarkCoverage,
  from = 0,
  to = coverage[0]?.length ?? 0,
): Mark[] {
  const marks: Mark[] = [];
  coverage.forEach((row, index) => {
    const type: MarkType = MARK_TYPES[index]!;
    let start = from;
    for (let i = from; i <= to; i += 1) {
      const value = i < to ? row[i]! : null;
      const previous = i > from ? row[i - 1]! : null;
      if (i > from && value === previous) continue;
      if (previous !== null) {
        const mark: Mark = { type, from: start - from, to: i - from };
        if (type === "link" && previous !== "") mark.href = previous;
        marks.push(mark);
      }
      start = i;
    }
  });
  return marks.sort(
    (a, b) =>
      a.from - b.from ||
      MARK_TYPES.indexOf(a.type) - MARK_TYPES.indexOf(b.type),
  );
}

/** Whether `marks` (offsets inside the range) repeat what base[from, to) has. */
export function sameMarksOver(
  base: Pick<Block, "marks">,
  from: number,
  to: number,
  marks: Mark[],
): boolean {
  const length = to - from;
  const before = markCoverage(
    base.marks.map((mark) => ({
      ...mark,
      from: mark.from - from,
      to: mark.to - from,
    })),
    length,
  );
  const after = markCoverage(marks, length);
  for (let i = 0; i < length; i += 1) {
    if (!sameFormatAt(before, i, after, i)) return false;
  }
  return true;
}

/**
 * What a formatting-only operation changes on base[from, to): the marks some
 * of its text gains or loses, and whether a link changes its address.
 */
export function markChanges(
  base: Pick<Block, "marks">,
  op: Pick<ReplaceOp, "from" | "to" | "marks">,
): FormatChange[] {
  const length = op.to - op.from;
  const before = markCoverage(
    base.marks.map((mark) => ({
      ...mark,
      from: mark.from - op.from,
      to: mark.to - op.from,
    })),
    length,
  );
  const after = markCoverage(op.marks ?? [], length);
  const changes: FormatChange[] = [];
  MARK_TYPES.forEach((type, index) => {
    let on = false;
    let off = false;
    let changed = false;
    for (let i = 0; i < length; i += 1) {
      const was = before[index]![i]!;
      const is = after[index]![i]!;
      if (was === is) continue;
      if (was === null) on = true;
      else if (is === null) off = true;
      else changed = true;
    }
    if (on) changes.push({ code: `${type}_on` });
    if (off) changes.push({ code: `${type}_off` });
    if (changed && type === "link") changes.push({ code: "link_changed" });
  });
  return changes;
}

// Operations -----------------------------------------------------------------

/** An operation that changes the format of its whole block. */
export function isBlockFormatOp(op: Pick<ReplaceOp, "block">): boolean {
  return op.block !== undefined;
}

/** An operation that keeps its text and changes only its inline marks. */
export function isMarksOnlyOp(
  op: Pick<ReplaceOp, "text" | "baseText" | "marks" | "block">,
): boolean {
  return (
    op.block === undefined &&
    op.marks !== undefined &&
    op.text === op.baseText &&
    op.text !== ""
  );
}

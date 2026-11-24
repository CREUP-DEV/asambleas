import { z } from "zod/v4";
import { CELL_FILL_NAMES } from "../../constants/cellFills";
import {
  BLOCK_ALIGNMENTS,
  BLOCK_TYPES,
  CELL_BORDER_STYLES,
  CELL_SIDES,
  IMAGE_ASSET_PATTERN,
  LIST_MARKERS,
  MARK_TYPES,
  TABLE_MIN_WIDTH,
} from "../../types/content";
import type {
  Block,
  BlockCell,
  BlockFormat,
  BlockImage,
  Mark,
  ReplaceOp,
} from "../../types/content";
import { normalizeBlockFormat } from "../content/format";
import { isSafeHref } from "../content/render";

export const BLOCK_TEXT_MAX_LENGTH = 20_000;
export const DOCUMENT_MAX_BLOCKS = 3_000;
export const BLOCK_ID_PATTERN = /^[a-zA-Z0-9_-]{4,40}$/;

const blockIdSchema = z.string().regex(BLOCK_ID_PATTERN);

// Control characters other than tab and newline never belong in content.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
}

const markSchema = z.object({
  type: z.enum(MARK_TYPES),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  href: z.string().max(2000).optional(),
});

/**
 * A formula inside a sentence is one piece: formula marks never overlap each
 * other (the first one stays) and the other marks leave their ranges (split
 * around them).
 */
function separateFormulas(marks: Mark[]): Mark[] {
  const formulas: Mark[] = [];
  for (const mark of marks
    .filter((item) => item.type === "formula")
    .sort((a, b) => a.from - b.from)) {
    const last = formulas.at(-1);
    if (!last || mark.from >= last.to) formulas.push(mark);
  }
  if (formulas.length === 0) return marks;
  const others = marks.filter((mark) => mark.type !== "formula");
  const split: Mark[] = [];
  for (const mark of others) {
    let pieces: Mark[] = [mark];
    for (const formula of formulas) {
      pieces = pieces.flatMap((piece) => {
        if (piece.to <= formula.from || piece.from >= formula.to) {
          return [piece];
        }
        const out: Mark[] = [];
        if (piece.from < formula.from) {
          out.push({ ...piece, to: formula.from });
        }
        if (piece.to > formula.to) out.push({ ...piece, from: formula.to });
        return out;
      });
    }
    split.push(...pieces);
  }
  return [...split, ...formulas];
}

/**
 * Marks clipped to a text of `length`, empty ones dropped, links kept only
 * with an address that is safe to follow, and formulas kept apart.
 */
function cleanMarks(marks: z.infer<typeof markSchema>[], length: number) {
  return separateFormulas(
    marks
      .map((mark): Mark => ({
        type: mark.type,
        from: Math.min(mark.from, length),
        to: Math.min(mark.to, length),
        ...(mark.type === "link" && isSafeHref(mark.href)
          ? { href: mark.href.trim() }
          : {}),
      }))
      .filter((mark) => mark.from < mark.to)
      .filter((mark) => mark.type !== "link" || "href" in mark),
  );
}

const spanSchema = z.number().int().min(2).max(100).optional();

/** A cell reference (BlockCell): ids shaped like block ids. */
const cellSchema = z
  .object({
    table: blockIdSchema,
    row: blockIdSchema,
    cell: blockIdSchema,
    header: z.boolean().optional(),
    // A name of the palette, never a colour code.
    fill: z.enum(CELL_FILL_NAMES).optional(),
    // Content saved before the palette: read as "beige" (cellFillOf), and
    // kept as it came so that saving an untouched text changes nothing.
    shade: z.boolean().optional(),
    colspan: spanSchema,
    rowspan: spanSchema,
    borders: z
      .object({
        top: z.enum(CELL_BORDER_STYLES).optional(),
        right: z.enum(CELL_BORDER_STYLES).optional(),
        bottom: z.enum(CELL_BORDER_STYLES).optional(),
        left: z.enum(CELL_BORDER_STYLES).optional(),
      })
      .optional(),
    // 100 is the default, kept out as absent.
    tableWidth: z.number().int().min(TABLE_MIN_WIDTH).max(100).optional(),
    tableAlign: z.enum(BLOCK_ALIGNMENTS).optional(),
  })
  .transform((cell): BlockCell => {
    const result: BlockCell = {
      table: cell.table,
      row: cell.row,
      cell: cell.cell,
    };
    if (cell.header) result.header = true;
    if (cell.fill) result.fill = cell.fill;
    else if (cell.shade && !cell.header) result.shade = true;
    if (cell.colspan) result.colspan = cell.colspan;
    if (cell.rowspan) result.rowspan = cell.rowspan;
    if (cell.borders) {
      const borders: NonNullable<BlockCell["borders"]> = {};
      for (const side of CELL_SIDES) {
        const style = cell.borders[side];
        if (style) borders[side] = style;
      }
      if (Object.keys(borders).length > 0) result.borders = borders;
    }
    // A full-width table sits nowhere in particular.
    if (cell.tableWidth !== undefined && cell.tableWidth < 100) {
      result.tableWidth = cell.tableWidth;
      if (cell.tableAlign) result.tableAlign = cell.tableAlign;
    }
    return result;
  });

/** The longest description an image may carry. */
export const IMAGE_ALT_MAX_LENGTH = 500;

/** An image block's picture (BlockImage). */
const imageSchema = z
  .object({
    asset: z.string().regex(IMAGE_ASSET_PATTERN),
    width: z.number().int().min(1).max(20_000),
    height: z.number().int().min(1).max(20_000),
    alt: z.string().max(IMAGE_ALT_MAX_LENGTH),
  })
  .transform((image): BlockImage => ({
    asset: image.asset,
    width: image.width,
    height: image.height,
    alt: normalizeText(image.alt).replace(/\s+/g, " ").trim(),
  }));

export const blockSchema = z
  .object({
    id: blockIdSchema,
    type: z.enum(BLOCK_TYPES),
    level: z.number().int().min(0).max(6).optional(),
    list: z.enum(["bullet", "ordered"]).optional(),
    marker: z.enum(LIST_MARKERS).optional(),
    start: z.number().int().min(0).max(99_999).optional(),
    cell: cellSchema.optional(),
    align: z.enum(BLOCK_ALIGNMENTS).optional(),
    image: imageSchema.optional(),
    text: z.string().max(BLOCK_TEXT_MAX_LENGTH),
    marks: z.array(markSchema).max(500).default([]),
  })
  // An image block carries its picture and stays out of tables.
  .refine((block) => block.type !== "image" || (block.image && !block.cell), {
    message: "invalid_image",
  })
  .transform((block): Block => {
    if (block.type === "image") {
      const result: Block = {
        id: block.id,
        type: "image",
        image: block.image!,
        text: "",
        marks: [],
      };
      if (block.align) result.align = block.align;
      return result;
    }
    const text = normalizeText(block.text);
    // A formula block is its LaTeX source alone: no marks, no format.
    if (block.type === "formula") {
      const result: Block = { id: block.id, type: "formula", text, marks: [] };
      if (block.cell) result.cell = block.cell;
      return result;
    }
    const marks = cleanMarks(block.marks, text.length);
    const result: Block = { id: block.id, type: block.type, text, marks };
    if (block.type === "heading") result.level = block.level ?? 1;
    if (block.type === "list_item") {
      result.level = block.level ?? 0;
      result.list = block.list ?? "bullet";
      // Only ordered items number; "1." is the default and stays implicit.
      if (result.list === "ordered") {
        if (block.marker !== undefined && block.marker !== "1.") {
          result.marker = block.marker;
        }
        if (block.start !== undefined) result.start = block.start;
      }
    }
    if (block.cell) result.cell = block.cell;
    if (block.align) result.align = block.align;
    return result;
  });

export const blocksSchema = z
  .array(blockSchema)
  .max(DOCUMENT_MAX_BLOCKS)
  .refine(
    (blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length,
    { message: "duplicate_block_id" },
  );

/**
 * The new format of a block (BlockFormat), stored with only the fields its
 * type keeps, like a block's. Never an image.
 */
const blockFormatSchema = z
  .object({
    type: z.enum(["paragraph", "heading", "list_item", "quote"]),
    level: z.number().int().min(0).max(6).optional(),
    list: z.enum(["bullet", "ordered"]).optional(),
    marker: z.enum(LIST_MARKERS).optional(),
    start: z.number().int().min(0).max(99_999).optional(),
    align: z.enum(BLOCK_ALIGNMENTS).optional(),
  })
  .transform((format): BlockFormat => normalizeBlockFormat(format));

/**
 * A replacement, with the formatting it may bring (ReplaceOp): `marks` for
 * its new text, cleaned like a block's, or `block` for its whole block.
 * Operations stored before formatting could be amended have neither, and
 * come out as they went in.
 */
const replaceOpSchema = z
  .object({
    op: z.literal("replace"),
    blockId: blockIdSchema,
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    text: z.string().max(BLOCK_TEXT_MAX_LENGTH).transform(normalizeText),
    baseText: z.string().max(BLOCK_TEXT_MAX_LENGTH),
    marks: z.array(markSchema).max(500).optional(),
    block: blockFormatSchema.optional(),
  })
  .transform((op): ReplaceOp => {
    const result: ReplaceOp = {
      op: "replace",
      blockId: op.blockId,
      from: op.from,
      to: op.to,
      text: op.text,
      baseText: op.baseText,
    };
    if (op.marks) result.marks = cleanMarks(op.marks, op.text.length);
    if (op.block) result.block = op.block;
    return result;
  });

export const amendmentOpSchema = z.discriminatedUnion("op", [
  replaceOpSchema,
  z.object({
    op: z.literal("insert"),
    afterBlockId: blockIdSchema.nullable(),
    blocks: z.array(blockSchema).min(1).max(200),
  }),
  z.object({
    op: z.literal("delete"),
    blockIds: z.array(blockIdSchema).min(1).max(DOCUMENT_MAX_BLOCKS),
  }),
]);

export const amendmentOpsSchema = z.array(amendmentOpSchema).max(2_000);

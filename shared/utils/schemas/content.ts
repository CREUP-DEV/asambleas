import { z } from "zod/v4";
import {
  BLOCK_ALIGNMENTS,
  BLOCK_TYPES,
  LIST_MARKERS,
  MARK_TYPES,
} from "../../types/content";
import type { Block, BlockCell, Mark } from "../../types/content";
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

const spanSchema = z.number().int().min(2).max(100).optional();

/** A cell reference (BlockCell): ids shaped like block ids. */
const cellSchema = z
  .object({
    table: blockIdSchema,
    row: blockIdSchema,
    cell: blockIdSchema,
    header: z.boolean().optional(),
    colspan: spanSchema,
    rowspan: spanSchema,
  })
  .transform((cell): BlockCell => {
    const result: BlockCell = {
      table: cell.table,
      row: cell.row,
      cell: cell.cell,
    };
    if (cell.header) result.header = true;
    if (cell.colspan) result.colspan = cell.colspan;
    if (cell.rowspan) result.rowspan = cell.rowspan;
    return result;
  });

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
    text: z.string().max(BLOCK_TEXT_MAX_LENGTH),
    marks: z.array(markSchema).max(500).default([]),
  })
  .transform((block): Block => {
    const text = normalizeText(block.text);
    const marks: Mark[] = block.marks
      .map((mark) => ({
        type: mark.type,
        from: Math.min(mark.from, text.length),
        to: Math.min(mark.to, text.length),
        ...(mark.type === "link" && isSafeHref(mark.href)
          ? { href: mark.href.trim() }
          : {}),
      }))
      .filter((mark) => mark.from < mark.to)
      .filter((mark) => mark.type !== "link" || "href" in mark);
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

export const amendmentOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("replace"),
    blockId: blockIdSchema,
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    text: z.string().max(BLOCK_TEXT_MAX_LENGTH).transform(normalizeText),
    baseText: z.string().max(BLOCK_TEXT_MAX_LENGTH),
  }),
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

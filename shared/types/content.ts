/**
 * Structured document content.
 *
 * A document is a flat list of blocks with stable ids. Amendments never store
 * modified copies of the text: they store operations anchored to the blocks of
 * the frozen base version (see AmendmentOp).
 */

import type { CellFillName } from "../constants/cellFills";

export const BLOCK_TYPES = [
  "heading",
  "paragraph",
  "list_item",
  "quote",
  "image",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * How an ordered list numbers its items: the number format (1, a, A, i, I)
 * and what follows it. "1." when a block has none.
 */
export const LIST_MARKERS = [
  "1.",
  "1)",
  "a.",
  "a)",
  "A.",
  "A)",
  "i.",
  "i)",
  "I.",
  "I)",
] as const;
export type ListMarker = (typeof LIST_MARKERS)[number];

/**
 * Where a block sits when it is inside a table: the table, row and cell it
 * belongs to, by ids as stable as block ids. A table is the run of
 * consecutive blocks with one `table`; a row, those with one `row`; a cell,
 * those with one `cell`. A cell holds one block at least (an empty
 * paragraph when it is blank). Amendments change a cell's text like any
 * block's, and add or remove rows and columns by inserting or deleting the
 * blocks of their cells.
 */
export interface BlockCell {
  table: string;
  row: string;
  cell: string;
  /** A header cell. */
  header?: boolean;
  /**
   * The cell's fill, by its name in CREUP's palette (CELL_FILLS), never a
   * colour code. Only how the cell looks: a header cell may have one too,
   * and without one it keeps the header's burgundy.
   */
  fill?: CellFillName;
  /**
   * How content saved before the palette marks a beige body cell. Still
   * valid and read as the fill "beige" (cellFillOf); new content writes
   * `fill`.
   */
  shade?: boolean;
  /** Columns and rows the cell spans, when more than one. */
  colspan?: number;
  rowspan?: number;
}

/**
 * An image block's picture: an image stored for the document (`asset`, the
 * id of its row in `document_images`, served by /api/uploads/images/), its
 * size in pixels and the text that stands for it. Images hold no text of
 * their own (`text` is empty), sit outside tables and are never a link to
 * anything outside the platform.
 */
export interface BlockImage {
  asset: string;
  width: number;
  height: number;
  /** What the image shows, for those who cannot see it. */
  alt: string;
}

/** Ids of stored images (cuid2). */
export const IMAGE_ASSET_PATTERN = /^[a-z0-9]{20,32}$/;

/** Where stored images are served, by asset id. */
export const IMAGE_URL_PREFIX = "/api/uploads/images/";

/**
 * Alignments a block may take besides the default (start). Justified text
 * is left out on purpose: its uneven spacing is hard to read (WCAG 1.4.8).
 */
export const BLOCK_ALIGNMENTS = ["center", "right"] as const;
export type BlockAlign = (typeof BLOCK_ALIGNMENTS)[number];

export const MARK_TYPES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "link",
] as const;
export type MarkType = (typeof MARK_TYPES)[number];

/** Inline formatting over the half-open range [from, to) of a block's text. */
export interface Mark {
  type: MarkType;
  from: number;
  to: number;
  href?: string;
}

export interface Block {
  id: string;
  type: BlockType;
  /** Heading level (1-4) or list depth (0-based). */
  level?: number;
  list?: "bullet" | "ordered";
  /** Ordered list items: how their list numbers them. */
  marker?: ListMarker;
  /**
   * Ordered list items: the number this item takes. The list starts again
   * here, as after a paragraph that interrupts it ("c)" after "b)"); without
   * it, an item follows the one before at its level.
   */
  start?: number;
  /** Blocks inside a table: the cell they belong to. */
  cell?: BlockCell;
  /** Centred or right-aligned; aligned to the start when absent. */
  align?: BlockAlign;
  /** Image blocks: the picture. */
  image?: BlockImage;
  text: string;
  marks: Mark[];
}

/**
 * What a block is besides its text: the fields an amendment may change on a
 * block of the base. Never an image, and never the table cell it sits in.
 */
export interface BlockFormat {
  type: Exclude<BlockType, "image">;
  /** Heading level (1-4) or list depth (0-based). */
  level?: number;
  list?: "bullet" | "ordered";
  marker?: ListMarker;
  start?: number;
  align?: BlockAlign;
}

/**
 * Replaces base[from, to) of one block. Covers suppression, addition and
 * modification of text, and changes of formatting:
 * - `marks` is the inline formatting of the new text, with offsets inside
 *   `text`. It takes the place of the base marks over [from, to). With
 *   `text` equal to `baseText` the operation changes formatting only.
 *   Without it the base marks follow the text as they always did.
 * - `block` is the new format of the whole block (paragraph, heading of a
 *   level, list item...). It travels alone, on an operation with `from` and
 *   `to` at 0 and no text, one per block at most.
 */
export interface ReplaceOp {
  op: "replace";
  blockId: string;
  from: number;
  to: number;
  text: string;
  /** The base text being replaced, kept to verify the anchor. */
  baseText: string;
  marks?: Mark[];
  block?: BlockFormat;
}

/** Inserts new blocks after a base block, or at the start when afterBlockId is null. */
export interface InsertOp {
  op: "insert";
  afterBlockId: string | null;
  blocks: Block[];
}

/** Removes whole base blocks. */
export interface DeleteOp {
  op: "delete";
  blockIds: string[];
}

export type AmendmentOp = ReplaceOp | InsertOp | DeleteOp;

/** Change typology derived from the operations, as used in the regulations. */
export type ChangeKind = "suppression" | "addition" | "modification";

/**
 * One thing a formatting change does, for the label shown next to it:
 * - `bold_on`, `link_off`...: a mark the text gains or loses;
 * - `link_changed`: the address of a link changes;
 * - `paragraph`, `heading` (value: its level), `quote`, `bullet_list`,
 *   `ordered_list`: what the block becomes;
 * - `list_level` (value: the level, from 1), `list_marker` (value: how the
 *   first item reads, "a)"), `list_start` (value: the number), `list_continue`
 *   (the item no longer starts its list again);
 * - `align_start`, `align_center`, `align_right`.
 */
export const FORMAT_CHANGE_CODES = [
  "bold_on",
  "bold_off",
  "italic_on",
  "italic_off",
  "underline_on",
  "underline_off",
  "strike_on",
  "strike_off",
  "link_on",
  "link_off",
  "link_changed",
  "paragraph",
  "heading",
  "quote",
  "bullet_list",
  "ordered_list",
  "list_level",
  "list_marker",
  "list_start",
  "list_continue",
  "align_start",
  "align_center",
  "align_right",
] as const;
export type FormatChangeCode = (typeof FORMAT_CHANGE_CODES)[number];

export interface FormatChange {
  code: FormatChangeCode;
  value?: string | number;
}

/** A run of consolidated text and the amendment it comes from (null = base text). */
export interface Segment {
  text: string;
  source: string | null;
  /** Text removed by `source`. Only present in annotated output. */
  removed?: boolean;
  /**
   * Text `source` keeps and formats anew: what changes. Only present in
   * annotated output, and never together with `removed`.
   */
  format?: FormatChange[];
}

export interface ConsolidatedBlock {
  id: string;
  type: BlockType;
  level?: number;
  list?: "bullet" | "ordered";
  marker?: ListMarker;
  start?: number;
  cell?: BlockCell;
  align?: BlockAlign;
  image?: BlockImage;
  segments: Segment[];
  /** Marks over the clean text of the block (removed segments excluded). */
  marks: Mark[];
  /** "inserted" and "deleted" carry the amendment in `source`. */
  status: "kept" | "inserted" | "deleted";
  source: string | null;
  /**
   * A kept block whose format an amendment changes: the amendment and what
   * changes. The block already shows its new format.
   */
  format?: { source: string; changes: FormatChange[] };
}

export interface AmendmentInput {
  id: string;
  ops: AmendmentOp[];
}

export interface ConsolidationConflict {
  /** The amendment that could not be applied. */
  amendmentId: string;
  /** Already applied amendments it collides with. */
  conflictsWith: string[];
}

export interface ConsolidationResult {
  /** Annotated blocks, including removed text and deleted blocks. */
  annotated: ConsolidatedBlock[];
  /** Clean consolidated blocks, ready to store as a version. */
  blocks: Block[];
  applied: string[];
  conflicts: ConsolidationConflict[];
}

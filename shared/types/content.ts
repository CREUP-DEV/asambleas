/**
 * Structured document content.
 *
 * A document is a flat list of blocks with stable ids. Amendments never store
 * modified copies of the text: they store operations anchored to the blocks of
 * the frozen base version (see AmendmentOp).
 */

export const BLOCK_TYPES = [
  "heading",
  "paragraph",
  "list_item",
  "quote",
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
  /** Columns and rows the cell spans, when more than one. */
  colspan?: number;
  rowspan?: number;
}

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
  text: string;
  marks: Mark[];
}

/** Replaces base[from, to) of one block. Covers suppression, addition and modification. */
export interface ReplaceOp {
  op: "replace";
  blockId: string;
  from: number;
  to: number;
  text: string;
  /** The base text being replaced, kept to verify the anchor. */
  baseText: string;
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

/** A run of consolidated text and the amendment it comes from (null = base text). */
export interface Segment {
  text: string;
  source: string | null;
  /** Text removed by `source`. Only present in annotated output. */
  removed?: boolean;
}

export interface ConsolidatedBlock {
  id: string;
  type: BlockType;
  level?: number;
  list?: "bullet" | "ordered";
  marker?: ListMarker;
  start?: number;
  cell?: BlockCell;
  segments: Segment[];
  /** Marks over the clean text of the block (removed segments excluded). */
  marks: Mark[];
  /** "inserted" and "deleted" carry the amendment in `source`. */
  status: "kept" | "inserted" | "deleted";
  source: string | null;
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

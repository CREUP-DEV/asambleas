/**
 * Structured document content.
 *
 * A document is a flat list of blocks with stable ids. Amendments never store
 * modified copies of the text: they store operations anchored to the blocks of
 * the frozen base version (see AmendmentOp).
 */

export const BLOCK_TYPES = ["heading", "paragraph", "list_item", "quote"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

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

import type { AmendmentOp, Block } from "../../types/content";

/**
 * Paragraphs with occurrences a room view (the projection, the live view)
 * shows of a global replacement: the line that says it covers
 * the whole text, then the first of them and how many occurrences are left.
 */
export const GLOBAL_REPLACE_ROOM_BLOCKS = 3;

export interface GlobalReplaceExcerpt {
  /** The operations to show: every one in the first `limit` blocks. */
  ops: AmendmentOp[];
  /** Operations (occurrences) left out. */
  more: number;
}

/** The base block an operation sits on (an insert, the one it follows). */
function opBlock(op: AmendmentOp): string | null {
  if (op.op === "replace") return op.blockId;
  if (op.op === "delete") return op.blockIds[0] ?? null;
  return op.afterBlockId;
}

/**
 * The first occurrences of a global replacement: the operations on the
 * first `limit` blocks of `base` they touch, whole (a paragraph never
 * shows one of its occurrences replaced and another not), in their own
 * order, and how many are left out. Every operation without `limit` or
 * without the base to order them by.
 */
export function globalReplaceExcerpt(
  base: readonly Block[] | null,
  ops: AmendmentOp[],
  limit?: number,
): GlobalReplaceExcerpt {
  if (limit === undefined || !base) return { ops, more: 0 };
  const index = new Map(base.map((block, i) => [block.id, i]));
  const position = (op: AmendmentOp) => {
    const id = opBlock(op);
    return id === null ? -1 : (index.get(id) ?? base.length);
  };
  const positions = [...new Set(ops.map(position))].sort((a, b) => a - b);
  if (positions.length <= limit) return { ops, more: 0 };
  const shown = new Set(positions.slice(0, Math.max(0, limit)));
  const kept = ops.filter((op) => shown.has(position(op)));
  return { ops: kept, more: ops.length - kept.length };
}

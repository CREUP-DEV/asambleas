import type {
  AmendmentOp,
  Block,
  ChangeKind,
  ReplaceOp,
} from "../../types/content";

export interface OpError {
  index: number;
  reason: string;
}

export function indexBlocks(blocks: Block[]): Map<string, number> {
  return new Map(blocks.map((block, index) => [block.id, index]));
}

/** Pure point insertions and empty replacements are both "points". */
export function isPoint(op: Pick<ReplaceOp, "from" | "to">): boolean {
  return op.from === op.to;
}

/**
 * Text order for replacements in one block. At the same offset a point
 * insertion goes before a range that starts there, so the inserted text lands
 * in front of the rewritten passage whatever order the ops arrived in.
 */
export function compareReplaceOps(
  a: Pick<ReplaceOp, "from" | "to">,
  b: Pick<ReplaceOp, "from" | "to">,
): number {
  return a.from - b.from || a.to - b.to;
}

/**
 * Checks that operations are anchored to the base and consistent with each
 * other. An empty array means the amendment can be stored and applied.
 */
export function validateOps(base: Block[], ops: AmendmentOp[]): OpError[] {
  const errors: OpError[] = [];
  const index = indexBlocks(base);
  const deleted = new Set<string>();
  const anchors = new Set<string>();
  const newIds = new Set<string>();
  const replacesByBlock = new Map<string, { op: ReplaceOp; index: number }[]>();

  if (ops.length === 0) {
    errors.push({ index: -1, reason: "empty" });
  }

  ops.forEach((op, i) => {
    if (op.op === "delete") {
      if (op.blockIds.length === 0) {
        errors.push({ index: i, reason: "delete_empty" });
      }
      for (const id of op.blockIds) {
        if (!index.has(id)) errors.push({ index: i, reason: "unknown_block" });
        if (deleted.has(id))
          errors.push({ index: i, reason: "duplicate_delete" });
        deleted.add(id);
      }
      return;
    }

    if (op.op === "insert") {
      const anchorKey = op.afterBlockId ?? "\u0000start";
      if (op.afterBlockId !== null && !index.has(op.afterBlockId)) {
        errors.push({ index: i, reason: "unknown_anchor" });
      }
      if (anchors.has(anchorKey)) {
        errors.push({ index: i, reason: "duplicate_anchor" });
      }
      anchors.add(anchorKey);
      if (op.blocks.length === 0) {
        errors.push({ index: i, reason: "insert_empty" });
      }
      for (const block of op.blocks) {
        if (index.has(block.id) || newIds.has(block.id)) {
          errors.push({ index: i, reason: "duplicate_block_id" });
        }
        newIds.add(block.id);
      }
      return;
    }

    const position = index.get(op.blockId);
    if (position === undefined) {
      errors.push({ index: i, reason: "unknown_block" });
      return;
    }
    const text = base[position]!.text;
    if (
      !Number.isInteger(op.from) ||
      !Number.isInteger(op.to) ||
      op.from < 0 ||
      op.to < op.from ||
      op.to > text.length
    ) {
      errors.push({ index: i, reason: "out_of_range" });
      return;
    }
    if (text.slice(op.from, op.to) !== op.baseText) {
      errors.push({ index: i, reason: "anchor_mismatch" });
    }
    if (op.from === op.to && op.text === "") {
      errors.push({ index: i, reason: "noop" });
    }
    if (op.text === op.baseText) {
      errors.push({ index: i, reason: "noop" });
    }
    const list = replacesByBlock.get(op.blockId) ?? [];
    list.push({ op, index: i });
    replacesByBlock.set(op.blockId, list);
  });

  for (const [blockId, list] of replacesByBlock) {
    if (deleted.has(blockId)) {
      errors.push({
        index: list[0]!.index,
        reason: "replace_in_deleted_block",
      });
    }
    const sorted = [...list].sort((a, b) => compareReplaceOps(a.op, b.op));
    for (let k = 1; k < sorted.length; k += 1) {
      const prev = sorted[k - 1]!.op;
      const next = sorted[k]!.op;
      const samePoint =
        isPoint(prev) && isPoint(next) && prev.from === next.from;
      if (prev.to > next.from || samePoint) {
        errors.push({ index: sorted[k]!.index, reason: "overlapping_ops" });
      }
    }
  }

  return errors;
}

export function changeKindOf(op: AmendmentOp): ChangeKind {
  if (op.op === "insert") return "addition";
  if (op.op === "delete") return "suppression";
  if (op.from === op.to) return "addition";
  if (op.text === "") return "suppression";
  return "modification";
}

/** The typology of an amendment, as the regulations name it. */
export function changeKinds(ops: AmendmentOp[]): ChangeKind[] {
  const kinds = new Set(ops.map(changeKindOf));
  return (["suppression", "addition", "modification"] as const).filter((k) =>
    kinds.has(k),
  );
}

/** Ids of every base block an amendment touches, in operation order. */
export function touchedBlockIds(ops: AmendmentOp[]): string[] {
  const ids: string[] = [];
  for (const op of ops) {
    if (op.op === "replace") ids.push(op.blockId);
    else if (op.op === "delete") ids.push(...op.blockIds);
    else if (op.afterBlockId) ids.push(op.afterBlockId);
  }
  return [...new Set(ids)];
}

/**
 * Sort key that orders amendments by where they act in the base text.
 * Insertions sort right after their anchor block.
 */
export function positionKey(ops: AmendmentOp[], base: Block[]): number {
  const index = indexBlocks(base);
  let best = Number.POSITIVE_INFINITY;
  for (const op of ops) {
    let key: number;
    if (op.op === "replace") {
      const position = index.get(op.blockId) ?? base.length;
      key = position + op.from / (base[position]?.text.length || 1) / 2;
    } else if (op.op === "delete") {
      key = Math.min(...op.blockIds.map((id) => index.get(id) ?? base.length));
    } else {
      key =
        op.afterBlockId === null
          ? -0.5
          : (index.get(op.afterBlockId) ?? base.length) + 0.75;
    }
    best = Math.min(best, key);
  }
  return best;
}

/**
 * Builds the replace operations of a global term replacement ("y en lo
 * sucesivo"). Matches whole words, case-sensitively.
 */
export function globalReplaceOps(
  base: Block[],
  find: string,
  replacement: string,
): ReplaceOp[] {
  if (!find) return [];
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  const ops: ReplaceOp[] = [];
  for (const block of base) {
    for (const match of block.text.matchAll(pattern)) {
      const from = match.index ?? 0;
      ops.push({
        op: "replace",
        blockId: block.id,
        from,
        to: from + find.length,
        text: replacement,
        baseText: find,
      });
    }
  }
  return ops;
}

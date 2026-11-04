import type { AmendmentInput, AmendmentOp } from "../../types/content";

/**
 * - `same_text`: both change intersecting text of the same block (or insert
 *   at the very same point), so they cannot both be applied as written.
 * - `removed_block`: one deletes a block the other edits or also deletes.
 * - `same_position`: both insert new blocks after the same anchor. They can
 *   coexist, but the order between them has to be decided.
 */
export type OverlapKind = "same_text" | "removed_block" | "same_position";

export interface OverlapPair {
  a: string;
  b: string;
  kind: OverlapKind;
}

export interface OverlapReport {
  pairs: OverlapPair[];
  /** Groups of amendments linked by any overlap, each with 2+ members. */
  clusters: string[][];
}

type Range = { from: number; to: number };

export function rangesCollide(a: Range, b: Range): boolean {
  const aPoint = a.from === a.to;
  const bPoint = b.from === b.to;
  if (aPoint && bPoint) return a.from === b.from;
  if (aPoint) return b.from < a.from && a.from < b.to;
  if (bPoint) return a.from < b.from && b.from < a.to;
  return a.from < b.to && b.from < a.to;
}

interface Footprint {
  ranges: Map<string, Range[]>;
  deleted: Set<string>;
  anchors: Set<string>;
}

function footprint(ops: AmendmentOp[]): Footprint {
  const ranges = new Map<string, Range[]>();
  const deleted = new Set<string>();
  const anchors = new Set<string>();
  for (const op of ops) {
    if (op.op === "replace") {
      const list = ranges.get(op.blockId) ?? [];
      list.push({ from: op.from, to: op.to });
      ranges.set(op.blockId, list);
    } else if (op.op === "delete") {
      op.blockIds.forEach((id) => deleted.add(id));
    } else {
      anchors.add(op.afterBlockId ?? "\u0000start");
    }
  }
  return { ranges, deleted, anchors };
}

function collide(a: Footprint, b: Footprint): OverlapKind | null {
  for (const id of a.deleted) {
    if (b.deleted.has(id) || b.ranges.has(id)) return "removed_block";
  }
  for (const id of b.deleted) {
    if (a.ranges.has(id)) return "removed_block";
  }
  for (const [blockId, aRanges] of a.ranges) {
    const bRanges = b.ranges.get(blockId);
    if (!bRanges) continue;
    if (aRanges.some((x) => bRanges.some((y) => rangesCollide(x, y)))) {
      return "same_text";
    }
  }
  for (const anchor of a.anchors) {
    if (b.anchors.has(anchor)) return "same_position";
  }
  return null;
}

/** Hard collisions prevent applying both amendments together. */
export function isHardOverlap(kind: OverlapKind | null): boolean {
  return kind === "same_text" || kind === "removed_block";
}

export function overlapBetween(
  a: AmendmentOp[],
  b: AmendmentOp[],
): OverlapKind | null {
  return collide(footprint(a), footprint(b));
}

/**
 * Finds every pair of amendments that act on the same passage and groups them
 * into clusters. Detection uses the ranges each amendment really changes, not
 * the paragraph it quotes, so two edits to different sentences of the same
 * paragraph do not overlap.
 */
export function findOverlaps(amendments: AmendmentInput[]): OverlapReport {
  const prints = amendments.map((amendment) => footprint(amendment.ops));
  const byBlock = new Map<string, number[]>();
  prints.forEach((print, i) => {
    const keys = new Set([
      ...print.ranges.keys(),
      ...print.deleted,
      ...[...print.anchors].map((anchor) => `\u0001${anchor}`),
    ]);
    for (const key of keys) {
      const list = byBlock.get(key) ?? [];
      list.push(i);
      byBlock.set(key, list);
    }
  });

  const pairs: OverlapPair[] = [];
  const seen = new Set<string>();
  const parent = amendments.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };

  for (const candidates of byBlock.values()) {
    for (let x = 0; x < candidates.length; x += 1) {
      for (let y = x + 1; y < candidates.length; y += 1) {
        const i = candidates[x]!;
        const j = candidates[y]!;
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const kind = collide(prints[i]!, prints[j]!);
        if (!kind) continue;
        pairs.push({ a: amendments[i]!.id, b: amendments[j]!.id, kind });
        parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map<number, string[]>();
  amendments.forEach((amendment, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(amendment.id);
    groups.set(root, list);
  });

  return {
    pairs,
    clusters: [...groups.values()].filter((group) => group.length > 1),
  };
}

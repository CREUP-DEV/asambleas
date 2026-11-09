import type {
  AmendmentInput,
  Block,
  ConsolidatedBlock,
  ConsolidationConflict,
  ConsolidationResult,
  Mark,
  ReplaceOp,
  Segment,
} from "../../types/content";
import { copyShape } from "./lists";
import { compareReplaceOps, validateOps } from "./ops";
import { isHardOverlap, overlapBetween } from "./overlaps";

type SourcedReplace = ReplaceOp & { source: string };

/**
 * Maps a position of the base text to the consolidated text. `assoc` decides
 * which side of an insertion (or of a replaced range) the position lands on:
 * -1 keeps it before, 1 moves it after.
 */
export function mapPosition(
  position: number,
  ops: Pick<ReplaceOp, "from" | "to" | "text">[],
  assoc: -1 | 1,
): number {
  let delta = 0;
  for (const op of ops) {
    const pureInsertHere = op.from === op.to && op.from === position;
    if (op.to <= position && !pureInsertHere) {
      delta += op.text.length - (op.to - op.from);
      continue;
    }
    if (pureInsertHere) {
      return assoc > 0 ? position + delta + op.text.length : position + delta;
    }
    if (op.from < position) {
      return assoc < 0 ? op.from + delta : op.from + delta + op.text.length;
    }
    return position + delta;
  }
  return position + delta;
}

function mapMarks(marks: Mark[], ops: SourcedReplace[]): Mark[] {
  return marks
    .map((mark) => ({
      ...mark,
      from: mapPosition(mark.from, ops, 1),
      to: mapPosition(mark.to, ops, -1),
    }))
    .filter((mark) => mark.from < mark.to);
}

function buildSegments(block: Block, ops: SourcedReplace[]): Segment[] {
  const segments: Segment[] = [];
  const push = (segment: Segment) => {
    if (segment.text === "") return;
    const last = segments[segments.length - 1];
    if (
      last &&
      last.source === segment.source &&
      Boolean(last.removed) === Boolean(segment.removed)
    ) {
      last.text += segment.text;
    } else {
      segments.push(segment);
    }
  };

  let cursor = 0;
  for (const op of ops) {
    push({ text: block.text.slice(cursor, op.from), source: null });
    push({ text: op.baseText, source: op.source, removed: true });
    push({ text: op.text, source: op.source });
    cursor = op.to;
  }
  push({ text: block.text.slice(cursor), source: null });
  return segments;
}

function cleanText(segments: Segment[]): string {
  return segments
    .filter((segment) => !segment.removed)
    .map((segment) => segment.text)
    .join("");
}

/**
 * Applies approved amendments to the frozen base, in the given order.
 *
 * An amendment that is invalid against the base, or that collides with one
 * already applied (same text, or a block another removed), is skipped and
 * reported as a conflict: nothing is ever applied fuzzily. Insertions after
 * the same anchor follow the given order.
 *
 * Returns the clean blocks to store as the consolidated version and an
 * annotated copy where every segment names the amendment that produced it.
 */
export function consolidate(
  base: Block[],
  amendments: AmendmentInput[],
): ConsolidationResult {
  const applied: AmendmentInput[] = [];
  const conflicts: ConsolidationConflict[] = [];

  for (const amendment of amendments) {
    if (validateOps(base, amendment.ops).length > 0) {
      conflicts.push({ amendmentId: amendment.id, conflictsWith: [] });
      continue;
    }
    const collisions = applied
      .filter((other) =>
        isHardOverlap(overlapBetween(other.ops, amendment.ops)),
      )
      .map((other) => other.id);
    if (collisions.length > 0) {
      conflicts.push({ amendmentId: amendment.id, conflictsWith: collisions });
      continue;
    }
    applied.push(amendment);
  }

  const replaces = new Map<string, SourcedReplace[]>();
  const deletedBy = new Map<string, string>();
  const insertsAfter = new Map<string, { source: string; blocks: Block[] }[]>();

  for (const amendment of applied) {
    for (const op of amendment.ops) {
      if (op.op === "replace") {
        const list = replaces.get(op.blockId) ?? [];
        list.push({ ...op, source: amendment.id });
        replaces.set(op.blockId, list);
      } else if (op.op === "delete") {
        op.blockIds.forEach((id) => deletedBy.set(id, amendment.id));
      } else {
        const key = op.afterBlockId ?? "\u0000start";
        const list = insertsAfter.get(key) ?? [];
        list.push({ source: amendment.id, blocks: op.blocks });
        insertsAfter.set(key, list);
      }
    }
  }

  const annotated: ConsolidatedBlock[] = [];
  const pushInserted = (key: string) => {
    for (const insert of insertsAfter.get(key) ?? []) {
      for (const block of insert.blocks) {
        annotated.push({
          id: block.id,
          type: block.type,
          level: block.level,
          list: block.list,
          marker: block.marker,
          start: block.start,
          cell: block.cell,
          align: block.align,
          image: block.image,
          segments: [{ text: block.text, source: insert.source }],
          marks: block.marks,
          status: "inserted",
          source: insert.source,
        });
      }
    }
  };

  pushInserted("\u0000start");
  for (const block of base) {
    const deleter = deletedBy.get(block.id);
    if (deleter) {
      annotated.push({
        id: block.id,
        type: block.type,
        level: block.level,
        list: block.list,
        marker: block.marker,
        start: block.start,
        cell: block.cell,
        align: block.align,
        image: block.image,
        segments: [{ text: block.text, source: deleter, removed: true }],
        marks: [],
        status: "deleted",
        source: deleter,
      });
    } else {
      const ops = (replaces.get(block.id) ?? []).sort(compareReplaceOps);
      annotated.push({
        id: block.id,
        type: block.type,
        level: block.level,
        list: block.list,
        marker: block.marker,
        start: block.start,
        cell: block.cell,
        align: block.align,
        image: block.image,
        segments: buildSegments(block, ops),
        marks: mapMarks(block.marks, ops),
        status: "kept",
        source: null,
      });
    }
    pushInserted(block.id);
  }

  const blocks: Block[] = annotated
    .filter((block) => block.status !== "deleted")
    .map((block) => {
      const result: Block = {
        id: block.id,
        type: block.type,
        text: cleanText(block.segments),
        marks: block.marks,
      };
      return copyShape(block, result);
    });

  return {
    annotated,
    blocks,
    applied: applied.map((amendment) => amendment.id),
    conflicts,
  };
}

/**
 * Preview of a single amendment over the base: only the blocks it touches,
 * plus the blocks it inserts, with removed text kept for the diff view.
 */
export function previewAmendment(
  base: Block[],
  amendment: AmendmentInput,
  context = 0,
): ConsolidatedBlock[] {
  const { annotated } = consolidate(base, [amendment]);
  const touched = annotated
    .map((block, i) => ({ block, i }))
    .filter(
      ({ block }) =>
        block.status !== "kept" ||
        block.segments.some((segment) => segment.source !== null),
    )
    .map(({ i }) => i);
  if (touched.length === 0) return [];
  const keep = new Set<number>();
  for (const i of touched) {
    for (let k = i - context; k <= i + context; k += 1) {
      if (k >= 0 && k < annotated.length) keep.add(k);
    }
  }
  return annotated.filter((_, i) => keep.has(i));
}

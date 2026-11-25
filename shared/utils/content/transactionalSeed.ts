import type { AmendmentInput, Block } from "../../types/content";
import { cellFillOf } from "../../constants/cellFills";
import { copyShape, seedListStarts } from "./lists";
import { touchedBlockIds } from "./ops";
import { consolidateApproved, type ApprovedConsolidation } from "./passages";
import { cellLayoutKey } from "./tables";

/**
 * The starting text of a transactional, the same for the members' composer
 * (transactionalComposerSeed) and the Mesa's (sessionTransactionalSeed),
 * and the comparisons that tell whether it was edited.
 */
export interface TransactionalSeed {
  /** The contiguous run of base blocks the sources touch. */
  passage: Block[];
  /** The base block right before the passage, null at the start. */
  anchorBefore: string | null;
  /**
   * The base blocks before the passage, which the sources leave alone:
   * diffPassage reads the seed's list numbers against them.
   */
  before: Block[];
  /**
   * The passage with the sources applied, ready for the editor. Its ordered
   * items carry the numbers they show in the text (seedListStarts), so a
   * passage from "k)" does not start at "a)".
   */
  seed: Block[];
  /**
   * Sources left out of the seed, in the order given: invalid, or they
   * collide with an earlier one and do not merge with it.
   */
  skipped: string[];
}

/**
 * Starting point of a transactional: the passage touched by its sources,
 * with the sources applied in the given order as the approved text merges
 * them (consolidateApproved): changes of one paragraph that do not step on
 * each other word by word merge, and the same change twice counts once.
 * Where they do collide, the first applicable one wins and the others are
 * `skipped` whole (seedConsolidation). Blocks the sources insert get fresh ids, so
 * they never clash with the sources' own, and every block has marks of its
 * own, so the editor never touches a source's. Diff the edited text with
 * `diffPassage(passage, edited, anchorBefore, newId, before)`, so the list
 * numbers the seed carries are no change.
 */
export function transactionalSeed(
  base: Block[],
  sources: AmendmentInput[],
  newId: () => string,
  /**
   * Paragraphs taken in before and after what the sources touch (user's
   * decision of 2026-11-20): a transactional may need to change text
   * around them too. None by default.
   */
  widen: { before: number; after: number } = { before: 0, after: 0 },
): TransactionalSeed {
  const index = new Map(base.map((block, i) => [block.id, i]));
  const positions: number[] = [];
  for (const source of sources) {
    for (const id of touchedBlockIds(source.ops)) {
      const position = index.get(id);
      if (position !== undefined) positions.push(position);
    }
    if (
      source.ops.some((op) => op.op === "insert" && op.afterBlockId === null)
    ) {
      positions.push(0);
    }
  }
  if (positions.length === 0 || base.length === 0) {
    return {
      passage: [],
      anchorBefore: null,
      before: [],
      seed: [],
      skipped: [],
    };
  }

  const lo = Math.max(0, Math.min(...positions) - Math.max(0, widen.before));
  const hi = Math.min(
    base.length - 1,
    Math.max(...positions) + Math.max(0, widen.after),
  );
  const { result, skipped } = seedConsolidation(base, sources);

  const seed: Block[] = [];
  let current = -1;
  for (const block of result.annotated) {
    if (block.status === "inserted") {
      const inside =
        (current >= lo || (lo === 0 && current === -1)) && current <= hi;
      if (!inside) continue;
    } else {
      current = index.get(block.id) ?? current;
      if (block.status === "deleted" || current < lo || current > hi) continue;
    }
    const clean: Block = {
      id: block.status === "inserted" ? newId() : block.id,
      type: block.type,
      text: block.segments
        .filter((segment) => !segment.removed)
        .map((segment) => segment.text)
        .join(""),
      marks: block.marks.map((mark) => ({ ...mark })),
    };
    seed.push(copyShape(block, clean));
  }
  const before = base.slice(0, lo);

  return {
    passage: base.slice(lo, hi + 1),
    anchorBefore: lo > 0 ? base[lo - 1]!.id : null,
    before,
    seed: seedListStarts(before, seed),
    skipped,
  };
}

/** The approved text leaves some change out: it is not all applied. */
function leavesOut(result: ApprovedConsolidation): boolean {
  return (
    result.conflicts.length > 0 ||
    result.passages.some((passage) => passage.dropped.length > 0)
  );
}

/**
 * The sources applied as the approved text applies them, taken one by one
 * in the given order: a source joins when, merged with those already in,
 * every change of all of them still applies; otherwise it is skipped whole
 * (invalid, or it collides with one already in), as `consolidate` skips
 * one, so the first that fits wins and a source is never half applied.
 */
function seedConsolidation(
  base: Block[],
  sources: AmendmentInput[],
): { result: ApprovedConsolidation; skipped: string[] } {
  const taken: AmendmentInput[] = [];
  const skipped: string[] = [];
  let result: ApprovedConsolidation | null = null;
  for (const source of sources) {
    const trial = consolidateApproved(base, [...taken, source]);
    if (leavesOut(trial)) {
      skipped.push(source.id);
      continue;
    }
    taken.push(source);
    result = trial;
  }
  return { result: result ?? consolidateApproved(base, []), skipped };
}

/**
 * A cell as the comparison reads it: `shade` (content from before the
 * palette) and the fill "beige" are the same, as the editor returns them.
 */
function cellContent(cell: NonNullable<Block["cell"]>): unknown[] {
  return [
    cell.table,
    cell.row,
    cell.cell,
    cell.header ?? false,
    cellFillOf(cell) ?? null,
    cell.colspan ?? 1,
    cell.rowspan ?? 1,
    ...cellLayoutKey(cell),
  ];
}

function blockContent(block: Block): string {
  return JSON.stringify([
    block.type,
    block.text,
    block.level ?? null,
    block.list ?? null,
    block.marker ?? null,
    block.start ?? null,
    block.cell ? cellContent(block.cell) : null,
    block.align ?? null,
    block.marks,
  ]);
}

/**
 * Whether two block lists hold the same text and formatting. Ids are left
 * out: the editor may give a block a new id without changing its content.
 * Tells whether a transactional's draft was edited away from its seed.
 * Not the pending conciliation's sameBlocks, which compares ids too.
 */
export function sameBlockContent(a: Block[], b: Block[]): boolean {
  return (
    a.length === b.length &&
    a.every((block, index) => blockContent(block) === blockContent(b[index]!))
  );
}

/** Same ids, in any order and ignoring repeats. */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

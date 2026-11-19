import type {
  AmendmentInput,
  AmendmentOp,
  Block,
  ConsolidatedBlock,
  ConsolidationConflict,
  ConsolidationResult,
  ReplaceOp,
} from "../../types/content";
import { annotatedFragment, consolidate } from "./consolidate";
import { validateOps } from "./ops";
import { rangesCollide } from "./overlaps";

/**
 * The text approved amendments leave (user's decisions of 2026-11-19):
 * each one is debated and approved over the text as it stands, so changing
 * text another approved amendment changed is no reason to lapse or to fail
 * the final vote.
 *
 * - Deleting a block wins on its own over the approved changes inside it,
 *   whatever the order they were approved in: those amendments stay
 *   approved but those changes have no effect on the final text
 *   (`superseded`).
 * - Any other collision (the same text, or changes that touch each other)
 *   is a passage the Mesa words (`passages`). Until it does, the text
 *   carries an automatic proposal: where they change the same text, the
 *   last approved wins; where they only touch, both apply.
 * - A wording the Mesa set for exactly the amendments and blocks of a
 *   passage replaces their changes there, a deletion included (it corrects
 *   it). Once the passage changes (one of them reopened, another approved
 *   over those blocks) the wording no longer applies, but it is kept: if the
 *   passage reads the same again, it applies again.
 *
 * Everything stays relative to the base, so no change is ever rebased: the
 * proposal only leaves changes out. `amendments` come in approval order
 * (inApprovalOrder).
 */

/** A wording the Mesa set for a passage. */
export interface PassageWordingInput {
  id: string;
  amendmentIds: string[];
  blockIds: string[];
  ops: AmendmentOp[];
}

/**
 * - `pending`: changes collide; the text carries the automatic proposal
 *   until the Mesa words it.
 * - `automatic`: a deletion wins over changes inside the blocks it deletes,
 *   with no need to word anything (the Mesa may still correct it).
 * - `worded`: the Mesa's wording applies.
 */
export type PassageStatus = "pending" | "automatic" | "worded";

export interface Passage {
  /** amendmentIds and blockIds, sorted: what a wording is set for. */
  key: string;
  /** Every approved amendment that changes these blocks, in approval order. */
  amendmentIds: string[];
  /** The base blocks where they collide, in base order. */
  blockIds: string[];
  status: PassageStatus;
  wordingId: string | null;
  /**
   * The amendments the automatic proposal leaves changes of out (a later
   * one changes the same text, or a deletion wins over them).
   */
  dropped: string[];
}

/** An approved amendment whose changes in `blockIds` `by` deletes. */
export interface SupersededChange {
  amendmentId: string;
  by: string;
  blockIds: string[];
}

export interface ApprovedConsolidation extends ConsolidationResult {
  passages: Passage[];
  superseded: SupersededChange[];
  /** The Mesa's wordings that apply. */
  wordingIds: string[];
}

type Range = { from: number; to: number };

function isFormat(op: ReplaceOp): boolean {
  return op.block !== undefined;
}

/** Two changes of one block's text that touch without intersecting. */
export function rangesTouch(a: Range, b: Range): boolean {
  if (rangesCollide(a, b)) return false;
  return a.to === b.from || b.to === a.from;
}

/** Whether two changes of the same block cannot both apply as written. */
function opsCollide(a: ReplaceOp, b: ReplaceOp): boolean {
  return isFormat(a) || isFormat(b) || rangesCollide(a, b);
}

interface Touch {
  replaces: ReplaceOp[];
  deleted: boolean;
}

function touchesOf(ops: AmendmentOp[]): Map<string, Touch> {
  const touches = new Map<string, Touch>();
  const touch = (id: string) => {
    let entry = touches.get(id);
    if (!entry) {
      entry = { replaces: [], deleted: false };
      touches.set(id, entry);
    }
    return entry;
  };
  for (const op of ops) {
    if (op.op === "replace") touch(op.blockId).replaces.push(op);
    else if (op.op === "delete")
      op.blockIds.forEach((id) => (touch(id).deleted = true));
  }
  return touches;
}

type Link = "removed_block" | "same_text" | "adjacent";

/** How two amendments meet in one block, if they do. */
function linkIn(a: Touch, b: Touch): Link | null {
  if (a.deleted || b.deleted) return "removed_block";
  let touching = false;
  for (const x of a.replaces) {
    for (const y of b.replaces) {
      if (opsCollide(x, y)) return "same_text";
      if (rangesTouch(x, y)) touching = true;
    }
  }
  return touching ? "adjacent" : null;
}

/**
 * Whether two amendments meet in some block: one deletes what the other
 * changes, or they change the same text or text that touches.
 */
export function amendmentsMeet(a: AmendmentOp[], b: AmendmentOp[]): boolean {
  const left = touchesOf(a);
  const right = touchesOf(b);
  for (const [blockId, touch] of left) {
    const other = right.get(blockId);
    if (other && linkIn(touch, other)) return true;
  }
  return false;
}

/** What a wording is set for: its amendments and blocks, sorted. */
export function passageKey(
  amendmentIds: readonly string[],
  blockIds: readonly string[],
): string {
  return `${[...amendmentIds].sort().join(",")}|${[...blockIds].sort().join(",")}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Whether a wording only changes the passage it is set for. */
function wordingFits(
  base: Block[],
  ops: AmendmentOp[],
  blockIds: string[],
): boolean {
  if (ops.length === 0 || validateOps(base, ops).length > 0) return false;
  const blocks = new Set(blockIds);
  const positions = base
    .map((block, i) => (blocks.has(block.id) ? i : -1))
    .filter((i) => i >= 0);
  const first = Math.min(...positions);
  const anchorBefore = first > 0 ? base[first - 1]!.id : null;
  return ops.every((op) => {
    if (op.op === "replace") return blocks.has(op.blockId);
    if (op.op === "delete") return op.blockIds.every((id) => blocks.has(id));
    return (
      op.afterBlockId === anchorBefore ||
      (op.afterBlockId !== null && blocks.has(op.afterBlockId))
    );
  });
}

/** The ops of `ops` left once `dropReplace` / `dropDelete` are taken out. */
function keepOps(
  ops: AmendmentOp[],
  dropReplace: Set<ReplaceOp>,
  dropDelete: Set<string>,
): AmendmentOp[] {
  const kept: AmendmentOp[] = [];
  for (const op of ops) {
    if (op.op === "replace") {
      if (!dropReplace.has(op)) kept.push(op);
    } else if (op.op === "delete") {
      const blockIds = op.blockIds.filter((id) => !dropDelete.has(id));
      if (blockIds.length > 0) kept.push({ ...op, blockIds });
    } else {
      kept.push(op);
    }
  }
  return kept;
}

export function consolidateApproved(
  base: Block[],
  amendments: AmendmentInput[],
  options: { wordings?: readonly PassageWordingInput[] } = {},
): ApprovedConsolidation {
  const conflicts: ConsolidationConflict[] = [];
  const valid: AmendmentInput[] = [];
  for (const amendment of amendments) {
    if (amendment.ops.length === 0) continue;
    if (validateOps(base, amendment.ops).length > 0) {
      conflicts.push({ amendmentId: amendment.id, conflictsWith: [] });
    } else {
      valid.push(amendment);
    }
  }
  const touches = valid.map((amendment) => touchesOf(amendment.ops));
  const order = new Map(valid.map((amendment, i) => [amendment.id, i]));
  const basePosition = new Map(base.map((block, i) => [block.id, i]));

  // Blocks where two approved amendments meet, and how.
  const byBlock = new Map<string, number[]>();
  touches.forEach((touch, i) => {
    for (const blockId of touch.keys()) {
      const list = byBlock.get(blockId) ?? [];
      list.push(i);
      byBlock.set(blockId, list);
    }
  });
  const contested = new Map<string, Set<Link>>();
  for (const [blockId, members] of byBlock) {
    for (let x = 0; x < members.length; x += 1) {
      for (let y = x + 1; y < members.length; y += 1) {
        const link = linkIn(
          touches[members[x]!]!.get(blockId)!,
          touches[members[y]!]!.get(blockId)!,
        );
        if (!link) continue;
        const links = contested.get(blockId) ?? new Set<Link>();
        links.add(link);
        contested.set(blockId, links);
      }
    }
  }

  // A passage: every amendment that changes a contested block, joined with
  // those of the other contested blocks they change.
  const parent = valid.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (const blockId of contested.keys()) {
    const members = byBlock.get(blockId)!;
    for (const member of members.slice(1)) {
      parent[find(member)] = find(members[0]!);
    }
  }
  const groups = new Map<number, { members: number[]; blocks: string[] }>();
  for (const blockId of contested.keys()) {
    const root = find(byBlock.get(blockId)![0]!);
    const group = groups.get(root) ?? { members: [], blocks: [] };
    group.blocks.push(blockId);
    groups.set(root, group);
  }
  for (const [root, group] of groups) {
    group.members = valid.map((_, i) => i).filter((i) => find(i) === root);
    group.blocks.sort(
      (a, b) => (basePosition.get(a) ?? 0) - (basePosition.get(b) ?? 0),
    );
  }

  const dropReplace = new Set<ReplaceOp>();
  const dropDelete = valid.map(() => new Set<string>());
  const passages: Passage[] = [];
  const superseded: SupersededChange[] = [];
  const wordingInputs: AmendmentInput[] = [];
  const wordingIds: string[] = [];

  for (const group of groups.values()) {
    const amendmentIds = group.members.map((i) => valid[i]!.id);
    const blocks = new Set(group.blocks);
    const key = passageKey(amendmentIds, group.blocks);
    const wording = options.wordings?.find(
      (candidate) =>
        sameSet(candidate.amendmentIds, amendmentIds) &&
        sameSet(candidate.blockIds, group.blocks) &&
        wordingFits(base, candidate.ops, group.blocks),
    );

    if (wording) {
      for (const i of group.members) {
        for (const [blockId, touch] of touches[i]!) {
          if (!blocks.has(blockId)) continue;
          touch.replaces.forEach((op) => dropReplace.add(op));
          if (touch.deleted) dropDelete[i]!.add(blockId);
        }
      }
      wordingInputs.push({ id: wording.id, ops: wording.ops });
      wordingIds.push(wording.id);
      passages.push({
        key,
        amendmentIds,
        blockIds: group.blocks,
        status: "worded",
        wordingId: wording.id,
        dropped: [],
      });
      continue;
    }

    // The automatic proposal.
    const dropped = new Set<number>();
    let collides = false;
    for (const blockId of group.blocks) {
      const members = group.members.filter((i) => touches[i]!.has(blockId));
      const deleter = members.find((i) => touches[i]!.get(blockId)!.deleted);
      if (deleter !== undefined) {
        // The first to delete it wins; another deletion of it adds nothing.
        for (const i of members) {
          if (i === deleter) continue;
          const touch = touches[i]!.get(blockId)!;
          if (touch.deleted) dropDelete[i]!.add(blockId);
          if (touch.replaces.length === 0) continue;
          touch.replaces.forEach((op) => dropReplace.add(op));
          dropped.add(i);
          const by = valid[deleter]!.id;
          const entry = superseded.find(
            (item) => item.amendmentId === valid[i]!.id && item.by === by,
          );
          if (entry) entry.blockIds.push(blockId);
          else
            superseded.push({
              amendmentId: valid[i]!.id,
              by,
              blockIds: [blockId],
            });
        }
        continue;
      }
      if (
        contested.get(blockId)?.has("same_text") ||
        contested.get(blockId)?.has("adjacent")
      ) {
        collides = true;
      }
      // The last approved wins over the same text; touching changes stay.
      const kept: ReplaceOp[] = [];
      for (const i of [...members].reverse()) {
        for (const op of touches[i]!.get(blockId)!.replaces) {
          if (kept.some((other) => opsCollide(op, other))) {
            dropReplace.add(op);
            dropped.add(i);
          }
        }
        kept.push(
          ...touches[i]!.get(blockId)!.replaces.filter(
            (op) => !dropReplace.has(op),
          ),
        );
      }
    }
    passages.push({
      key,
      amendmentIds,
      blockIds: group.blocks,
      status: collides ? "pending" : "automatic",
      wordingId: null,
      dropped: [...dropped].sort((a, b) => a - b).map((i) => valid[i]!.id),
    });
  }

  const inputs: AmendmentInput[] = [];
  valid.forEach((amendment, i) => {
    const ops = keepOps(amendment.ops, dropReplace, dropDelete[i]!);
    if (ops.length > 0) inputs.push({ id: amendment.id, ops });
  });
  const result = consolidate(base, [...inputs, ...wordingInputs]);
  const wordingSet = new Set(wordingIds);
  return {
    annotated: result.annotated,
    blocks: result.blocks,
    // Approved amendments whose text was taken into account, even where a
    // deletion or the Mesa's wording replaced it.
    applied: valid
      .map((amendment) => amendment.id)
      .filter(
        (id) =>
          !result.conflicts.some((conflict) => conflict.amendmentId === id),
      ),
    conflicts: [
      ...conflicts,
      ...result.conflicts.filter(
        (conflict) => !wordingSet.has(conflict.amendmentId),
      ),
    ],
    passages: passages.sort(
      (a, b) =>
        (basePosition.get(a.blockIds[0]!) ?? 0) -
          (basePosition.get(b.blockIds[0]!) ?? 0) ||
        (order.get(a.amendmentIds[0]!) ?? 0) -
          (order.get(b.amendmentIds[0]!) ?? 0),
    ),
    superseded,
    wordingIds: wordingIds.filter(
      (id) => !result.conflicts.some((conflict) => conflict.amendmentId === id),
    ),
  };
}

/**
 * The annotated blocks of a passage: from its first block to its last, and
 * the blocks inserted right after them.
 */
export function passageFragment(
  annotated: ConsolidatedBlock[],
  blockIds: readonly string[],
  context = 0,
): ConsolidatedBlock[] {
  const wanted = new Set(blockIds);
  const indices = annotated
    .map((block, i) => (wanted.has(block.id) ? i : -1))
    .filter((i) => i >= 0);
  if (indices.length === 0) return [];
  const first = Math.min(...indices);
  let last = Math.max(...indices);
  while (annotated[last + 1]?.status === "inserted") last += 1;
  const range: number[] = [];
  for (let i = first; i <= last; i += 1) range.push(i);
  return annotatedFragment(annotated, range, context);
}

/**
 * What approving `target` does to the approved text: the passage it would
 * join (and who else is in it), the approved changes its deletions win over
 * or the deletion that wins over it, and that passage as it reads now and as
 * it would read. Null when it meets no approved amendment.
 */
export interface ApprovalImpact {
  passage: Passage;
  /** The other approved amendments in the passage. */
  others: string[];
  /** Approved amendments whose changes `target` deletes. */
  supersedes: string[];
  /** The approved amendments that delete what `target` changes. */
  supersededBy: string[];
  now: ConsolidatedBlock[];
  after: ConsolidatedBlock[];
}

export function approvalImpact(
  base: Block[],
  approved: AmendmentInput[],
  target: AmendmentInput,
  wordings: readonly PassageWordingInput[] = [],
): ApprovalImpact | null {
  if (target.ops.length === 0) return null;
  const others = approved.filter((amendment) => amendment.id !== target.id);
  const next = consolidateApproved(base, [...others, target], { wordings });
  const passage = next.passages.find((item) =>
    item.amendmentIds.includes(target.id),
  );
  if (!passage) return null;
  const now = consolidateApproved(base, others, { wordings });
  return {
    passage,
    others: passage.amendmentIds.filter((id) => id !== target.id),
    supersedes: next.superseded
      .filter((item) => item.by === target.id)
      .map((item) => item.amendmentId),
    supersededBy: next.superseded
      .filter((item) => item.amendmentId === target.id)
      .map((item) => item.by),
    now: passageFragment(now.annotated, passage.blockIds),
    after: passageFragment(next.annotated, passage.blockIds),
  };
}

import type {
  AmendmentInput,
  AmendmentOp,
  Block,
  ConsolidatedBlock,
  ConsolidationConflict,
  ConsolidationResult,
  InsertOp,
  ReplaceOp,
} from "../../types/content";
import { annotatedFragment, consolidate } from "./consolidate";
import { diffText, wordEdits } from "./diff";
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
 * - Changes of the same paragraph that do not step on each other word by
 *   word merge on their own (user's decision of 2026-11-20; `merged`):
 *   the same change made twice counts once, and a change that rewrites a
 *   stretch is split into the words it really changes (wordEdits), so the
 *   word another amendment changes inside it, which it leaves as it was,
 *   takes that change ("en el marco del SIGC" and "SIGC" -> "Sistema
 *   Interno de Garantía de Calidad (SIGC)"). Only over a real word (three
 *   letters or digits at least): a rewrite that happens to keep a "la" or a
 *   "y" never anchors another change.
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
 * - `merged`: their changes merge word by word, all of them apply, with no
 *   need to word anything (the Mesa may still correct it).
 * - `worded`: the Mesa's wording applies.
 */
export type PassageStatus = "pending" | "automatic" | "merged" | "worded";

export interface Passage {
  /** amendmentIds and blockIds, sorted: what a wording is set for. */
  key: string;
  /**
   * Every approved amendment that changes, deletes or inserts after these
   * blocks, in approval order.
   */
  amendmentIds: string[];
  /**
   * The run of base blocks from the first where they collide to the last,
   * in base order: what the Mesa words as one piece of text.
   */
  blockIds: string[];
  status: PassageStatus;
  wordingId: string | null;
  /**
   * The amendments the automatic proposal leaves changes of out (a later
   * one changes the same text, or a deletion wins over them).
   */
  dropped: string[];
}

/**
 * An approved amendment whose changes in `blockIds` `by` deletes, or whose
 * changes of punctuation sit in a sentence `by` rewrites.
 */
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

/**
 * What an amendment does to one base block: changes of its text, deleting
 * it, or new blocks it inserts right after it (which never meet anything,
 * but a wording of the passage takes them over, since the passage shows
 * them).
 */
interface Touch {
  replaces: ReplaceOp[];
  deleted: boolean;
  inserts: InsertOp[];
}

function touchesOf(ops: AmendmentOp[]): Map<string, Touch> {
  const touches = new Map<string, Touch>();
  const touch = (id: string) => {
    let entry = touches.get(id);
    if (!entry) {
      entry = { replaces: [], deleted: false, inserts: [] };
      touches.set(id, entry);
    }
    return entry;
  };
  for (const op of ops) {
    if (op.op === "replace") touch(op.blockId).replaces.push(op);
    else if (op.op === "delete")
      op.blockIds.forEach((id) => (touch(id).deleted = true));
    else if (op.afterBlockId !== null) touch(op.afterBlockId).inserts.push(op);
  }
  return touches;
}

type Link = "removed_block" | "same_text" | "adjacent";

/** Whether a touch changes or deletes the block (not only inserts after it). */
function changes(touch: Touch): boolean {
  return touch.deleted || touch.replaces.length > 0;
}

/** How two amendments meet in one block, if they do. */
function linkIn(a: Touch, b: Touch): Link | null {
  if (!changes(a) || !changes(b)) return null;
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

/**
 * The ops of `ops` left once the dropped ones are taken out, each split
 * into its parts where a merge split it.
 */
function keepOps(
  ops: AmendmentOp[],
  dropped: Set<ReplaceOp | InsertOp>,
  dropDelete: Set<string>,
  split: Map<ReplaceOp, ReplaceOp[]>,
): AmendmentOp[] {
  const kept: AmendmentOp[] = [];
  for (const op of ops) {
    if (op.op === "delete") {
      const blockIds = op.blockIds.filter((id) => !dropDelete.has(id));
      if (blockIds.length > 0) kept.push({ ...op, blockIds });
    } else if (!dropped.has(op)) {
      kept.push(...((op.op === "replace" && split.get(op)) || [op]));
    }
  }
  return kept;
}

/** A real word: what a merged change may hang on. */
const ANCHOR_WORD = /[\p{L}\p{N}]{3,}/u;

function sameChange(a: ReplaceOp, b: ReplaceOp): boolean {
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.text === b.text &&
    JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? [])
  );
}

/**
 * A change that keeps its own base text inside what it puts there ("SIGC"
 * -> "Sistema Interno de Garantía de Calidad (SIGC)"): what sits right
 * beside it still reads beside the same words.
 */
function wrapsItsText(op: ReplaceOp): boolean {
  return (
    op.from < op.to &&
    ANCHOR_WORD.test(op.baseText) &&
    op.text.includes(op.baseText.trim())
  );
}

/**
 * Whether two changes of different amendments cannot both apply: they
 * change the same text, or they meet at one point and neither keeps its own
 * words there (UEX6 deletes "y la falta de contratación " and UM2 adds
 * "de PDI " right after it: "de PDI" was about the deleted words).
 */
function stepOn(a: ReplaceOp, b: ReplaceOp): boolean {
  if (rangesCollide(a, b)) return true;
  const meet = a.to === b.from || b.to === a.from;
  return meet && !wrapsItsText(a) && !wrapsItsText(b);
}

interface MergeUnit {
  owner: number;
  /** The amendment's own operation this one is, or is a part of. */
  source: ReplaceOp;
  op: ReplaceOp;
}

/**
 * Whether the changes of several approved amendments to one block merge
 * word by word, and how: the operations split into their parts and the
 * repeated ones. Null when they step on each other (or one changes the
 * block's format), and the block is left to the Mesa.
 */
/**
 * The stretches a replacement really rewrites, as diffText reads them (with
 * semantic cleanup, so a small word that happens to stay is part of the
 * rewrite), relative to its block.
 */
function rewrittenParts(op: ReplaceOp): ReplaceOp[] {
  if (op.marks?.length) return [op];
  return diffText(
    { id: op.blockId, type: "paragraph", text: op.baseText, marks: [] },
    op.text,
  ).map((part) => ({
    ...part,
    blockId: op.blockId,
    from: op.from + part.from,
    to: op.from + part.to,
  }));
}

/** A change of punctuation alone: no word goes or comes. */
function punctuationOnly(op: ReplaceOp): boolean {
  return !/[\p{L}\p{N}]/u.test(op.baseText + op.text);
}

const WORDS = /[\p{L}\p{N}]+/gu;

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(WORDS) ?? [];
}

/** Whether `text` has these words one after another. */
function hasWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const all = wordsOf(text);
  return all.some((_, i) => words.every((word, j) => all[i + j] === word));
}

/** Longest touch-up, in words, that a rewrite around it overrules. */
const TOUCH_UP_WORDS = 3;
/**
 * A rewrite overrules a touch-up only when it rewrites much more: at least
 * this many words, and this many times the touch-up's. Otherwise the two
 * may mean different things for the same words ("muchas" -> "bastantes"
 * against "en muchas asignaturas" -> "en asignaturas troncales"), and the
 * Mesa words them.
 */
const REWRITE_MIN_WORDS = 6;
const REWRITE_RATIO = 3;

/**
 * Whether `small` is a touch-up (punctuation, or a few words) that `wide`
 * leaves nowhere to go: a whole operation of its own amendment, smaller
 * than the rewrite, whose words the rewrite does not bring back.
 */
function touchUp(small: MergeUnit, wide: MergeUnit): boolean {
  if (small.op !== small.source) return false;
  if (small.op.to - small.op.from >= wide.op.to - wide.op.from) return false;
  if (punctuationOnly(wide.op)) return false;
  if (punctuationOnly(small.op)) return true;
  const before = wordsOf(small.op.baseText);
  const after = wordsOf(small.op.text);
  const rewritten = wordsOf(wide.op.baseText).length;
  return (
    rewritten >= REWRITE_MIN_WORDS &&
    rewritten >= REWRITE_RATIO * Math.max(before.length, 1) &&
    before.length <= TOUCH_UP_WORDS &&
    after.length <= TOUCH_UP_WORDS &&
    !hasWords(wide.op.text, before) &&
    !hasWords(wide.op.text, after)
  );
}

/**
 * - `split`: the operations split into the words they really change;
 * - `repeated`: the same change again, by a later amendment;
 * - `overruled`: changes of punctuation inside text another amendment
 *   rewrites, which have nothing left to apply to (`by` rewrites it).
 */
interface BlockMerge {
  split: Map<ReplaceOp, ReplaceOp[]>;
  repeated: ReplaceOp[];
  overruled: { op: ReplaceOp; owner: number; by: number }[];
}

function mergeBlock(
  members: { owner: number; replaces: ReplaceOp[] }[],
): BlockMerge | null {
  const units: MergeUnit[] = [];
  const repeated: ReplaceOp[] = [];
  const overruled: BlockMerge["overruled"] = [];
  for (const { owner, replaces } of members) {
    for (const op of replaces) {
      if (isFormat(op)) return null;
      if (units.some((unit) => sameChange(unit.op, op))) repeated.push(op);
      else units.push({ owner, source: op, op });
    }
  }
  const refined = new Set<ReplaceOp>();
  // Splits `x` so that none of its parts touches what `y` changes, when
  // `y` changes a real word that `x` leaves as it was.
  const resolve = (x: MergeUnit, y: MergeUnit): boolean => {
    if (refined.has(x.source) || x.op.marks?.length) return false;
    if (!ANCHOR_WORD.test(y.op.baseText)) return false;
    const parts = wordEdits(x.op);
    if (parts.some((part) => stepOn(part, y.op))) return false;
    refined.add(x.source);
    units.splice(
      units.indexOf(x),
      1,
      ...parts.map((op) => ({ owner: x.owner, source: x.source, op })),
    );
    return true;
  };
  for (let guard = 0; guard < 200; guard += 1) {
    let x: MergeUnit | undefined;
    let y: MergeUnit | undefined;
    for (const a of units) {
      y = units.find(
        (b) => b.owner !== a.owner && b !== a && stepOn(a.op, b.op),
      );
      if (y) {
        x = a;
        break;
      }
    }
    if (!x || !y) {
      const split = new Map<ReplaceOp, ReplaceOp[]>();
      for (const source of refined) {
        split.set(
          source,
          units.filter((unit) => unit.source === source).map((unit) => unit.op),
        );
      }
      return { split, repeated, overruled };
    }
    // The longer change is the one that rewrites around the other.
    const [wide, narrow] =
      x.op.to - x.op.from >= y.op.to - y.op.from ? [x, y] : [y, x];
    if (resolve(wide, narrow) || resolve(narrow, wide)) continue;
    // A space or a sign added right where another change ends or starts,
    // that the other change already puts there (US3 adds the space missing
    // after "49 %." and UM2's rewrite, ending there, ends with it): the
    // same change again.
    const echo = [x, y].find((unit) => {
      const other = unit === x ? y : x;
      const { op } = unit;
      if (op !== unit.source || op.from !== op.to || !punctuationOnly(op)) {
        return false;
      }
      return (
        (op.from === other.op.to && other.op.text.endsWith(op.text)) ||
        (op.from === other.op.from && other.op.text.startsWith(op.text))
      );
    });
    if (echo) {
      repeated.push(echo.source);
      units.splice(units.indexOf(echo), 1);
      continue;
    }
    // A small touch-up inside a sentence another amendment rewrites: the
    // rewrite takes that text away, so the touch-up has nowhere to go (UM3
    // rewrites a sentence where US1 adds two commas; T3 rewrites the
    // phrase where US5 turns "a la" into "al"). What the rewrite takes away
    // is read from its diff with semantic cleanup (diffText), so a "que" it
    // happens to keep does not count as the touch-up's place.
    const small = touchUp(x, y) ? x : touchUp(y, x) ? y : null;
    const rewrite = small === x ? y : x;
    if (
      !small ||
      !rewrittenParts(rewrite.op).some((part) => rangesCollide(part, small.op))
    ) {
      return null;
    }
    overruled.push({ op: small.source, owner: small.owner, by: rewrite.owner });
    units.splice(units.indexOf(small), 1);
  }
  return null;
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

  // A passage: the run of base blocks from the first contested block to
  // the last of those its amendments meet in (runs that overlap join), and
  // every approved amendment that changes, deletes or inserts after any of
  // them. Contiguous, so the Mesa words it as one piece of text.
  const parent = valid.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (const blockId of contested.keys()) {
    const linked = byBlock
      .get(blockId)!
      .filter((i) => changes(touches[i]!.get(blockId)!));
    for (const member of linked.slice(1)) {
      parent[find(member)] = find(linked[0]!);
    }
  }
  const spans = new Map<number, { lo: number; hi: number }>();
  for (const blockId of contested.keys()) {
    const root = find(
      byBlock.get(blockId)!.find((i) => changes(touches[i]!.get(blockId)!))!,
    );
    const at = basePosition.get(blockId) ?? 0;
    const span = spans.get(root);
    if (span) {
      span.lo = Math.min(span.lo, at);
      span.hi = Math.max(span.hi, at);
    } else spans.set(root, { lo: at, hi: at });
  }
  const runs: { lo: number; hi: number }[] = [];
  for (const span of [...spans.values()].sort((a, b) => a.lo - b.lo)) {
    const last = runs.at(-1);
    if (last && span.lo <= last.hi) last.hi = Math.max(last.hi, span.hi);
    else runs.push({ ...span });
  }

  const dropped = new Set<ReplaceOp | InsertOp>();
  const split = new Map<ReplaceOp, ReplaceOp[]>();
  const dropDelete = valid.map(() => new Set<string>());
  const passages: Passage[] = [];
  const superseded: SupersededChange[] = [];
  const wordingInputs: AmendmentInput[] = [];
  const wordingIds: string[] = [];

  for (const run of runs) {
    const blockIds = base.slice(run.lo, run.hi + 1).map((block) => block.id);
    const blocks = new Set(blockIds);
    const members = valid
      .map((_, i) => i)
      .filter((i) => blockIds.some((id) => touches[i]!.has(id)));
    const amendmentIds = members.map((i) => valid[i]!.id);
    const key = passageKey(amendmentIds, blockIds);
    const wording = options.wordings?.find(
      (candidate) =>
        sameSet(candidate.amendmentIds, amendmentIds) &&
        sameSet(candidate.blockIds, blockIds) &&
        wordingFits(base, candidate.ops, blockIds),
    );

    if (wording) {
      for (const i of members) {
        for (const [blockId, touch] of touches[i]!) {
          if (!blocks.has(blockId)) continue;
          touch.replaces.forEach((op) => dropped.add(op));
          touch.inserts.forEach((op) => dropped.add(op));
          if (touch.deleted) dropDelete[i]!.add(blockId);
        }
      }
      wordingInputs.push({ id: wording.id, ops: wording.ops });
      wordingIds.push(wording.id);
      passages.push({
        key,
        amendmentIds,
        blockIds,
        status: "worded",
        wordingId: wording.id,
        dropped: [],
      });
      continue;
    }

    // The automatic proposal.
    const left = new Set<number>();
    let collides = false;
    let merges = false;
    for (const blockId of blockIds) {
      if (!contested.has(blockId)) continue;
      const here = members.filter((i) => touches[i]!.has(blockId));
      const deleter = here.find((i) => touches[i]!.get(blockId)!.deleted);
      if (deleter !== undefined) {
        // The first to delete it wins; another deletion of it adds nothing.
        for (const i of here) {
          if (i === deleter) continue;
          const touch = touches[i]!.get(blockId)!;
          if (touch.deleted) dropDelete[i]!.add(blockId);
          if (touch.replaces.length === 0) continue;
          touch.replaces.forEach((op) => dropped.add(op));
          left.add(i);
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
      const merge = mergeBlock(
        here.map((i) => ({
          owner: i,
          replaces: touches[i]!.get(blockId)!.replaces,
        })),
      );
      if (merge) {
        merges = true;
        merge.split.forEach((parts, op) => split.set(op, parts));
        merge.repeated.forEach((op) => dropped.add(op));
        for (const { op, owner, by } of merge.overruled) {
          dropped.add(op);
          left.add(owner);
          const entry = superseded.find(
            (item) =>
              item.amendmentId === valid[owner]!.id &&
              item.by === valid[by]!.id,
          );
          if (entry) {
            if (!entry.blockIds.includes(blockId)) entry.blockIds.push(blockId);
          } else {
            superseded.push({
              amendmentId: valid[owner]!.id,
              by: valid[by]!.id,
              blockIds: [blockId],
            });
          }
        }
        continue;
      }
      collides = true;
      // The last approved wins over the same text; touching changes stay.
      const kept: ReplaceOp[] = [];
      for (const i of [...here].reverse()) {
        for (const op of touches[i]!.get(blockId)!.replaces) {
          if (kept.some((other) => opsCollide(op, other))) {
            dropped.add(op);
            left.add(i);
          }
        }
        kept.push(
          ...touches[i]!.get(blockId)!.replaces.filter(
            (op) => !dropped.has(op),
          ),
        );
      }
    }
    passages.push({
      key,
      amendmentIds,
      blockIds,
      status: collides ? "pending" : merges ? "merged" : "automatic",
      wordingId: null,
      dropped: [...left].sort((a, b) => a - b).map((i) => valid[i]!.id),
    });
  }

  const inputs: AmendmentInput[] = [];
  valid.forEach((amendment, i) => {
    const ops = keepOps(amendment.ops, dropped, dropDelete[i]!, split);
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

import DiffMatchPatch from "diff-match-patch";
import type {
  AmendmentOp,
  Block,
  DeleteOp,
  InsertOp,
  ReplaceOp,
} from "../../types/content";
import { mapMarks } from "./consolidate";
import { blocksToEditor, editorToBlocks } from "./editor";
import {
  blockFormatOf,
  coverageToMarks,
  markCoverage,
  sameBlockFormat,
  sameFormatAt,
} from "./format";
import {
  handedOnListStarts,
  markerOf,
  seedListStarts,
  withoutImpliedStarts,
} from "./lists";

const dmp = new DiffMatchPatch();

const TOKEN_PATTERN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? [];
}

/** Length of the text a diff inserts or removes. */
function changedLength(diffs: [number, string][]): number {
  return diffs.reduce(
    (sum, [kind, text]) =>
      kind === DiffMatchPatch.DIFF_EQUAL ? sum : sum + text.length,
    0,
  );
}

/**
 * Word-level diff: tokens are mapped to single characters so diff-match-patch
 * compares words instead of letters, then mapped back.
 *
 * Every word costs the same, so when a phrase is added next to a repeated one
 * two scripts can tie, and the forward one may strike and re-add the same
 * words. The diff is also run over the reversed words and the result that
 * changes less text is kept (the forward one on a tie).
 */
function diffWords(a: string, b: string): [number, string][] {
  const dictionary = new Map<string, string>();
  const tokens: string[] = [];
  const encode = (words: string[]) =>
    words
      .map((token) => {
        let code = dictionary.get(token);
        if (code === undefined) {
          code = String.fromCharCode(tokens.length + 0x100);
          dictionary.set(token, code);
          tokens.push(token);
        }
        return code;
      })
      .join("");
  const decode = (encoded: string[]) =>
    encoded.map((char) => tokens[char.charCodeAt(0) - 0x100]).join("");

  const run = (left: string[], right: string[], reversed: boolean) => {
    const diffs = dmp.diff_main(encode(left), encode(right), false);
    dmp.diff_cleanupSemantic(diffs);
    const decoded = diffs.map(([kind, encoded]): [number, string] => {
      // One character per word: reversing the characters restores word order.
      const chars = Array.from(encoded);
      return [kind, decode(reversed ? chars.reverse() : chars)];
    });
    return reversed ? decoded.reverse() : decoded;
  };

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  const forward = run(wordsA, wordsB, false);
  const backward = run([...wordsA].reverse(), [...wordsB].reverse(), true);
  return changedLength(backward) < changedLength(forward) ? backward : forward;
}

/**
 * Minimal replace operations turning `base.text` into `edited`. Changes that
 * are only separated by whitespace are merged, so "en su totalidad" ->
 * "de forma proporcional" reads as one change instead of three.
 */
export function diffText(base: Block, edited: string): ReplaceOp[] {
  if (base.text === edited) return [];
  const diffs = diffWords(base.text, edited);
  const ops: ReplaceOp[] = [];
  let position = 0;
  let open: { from: number; removed: string; inserted: string } | null = null;

  const close = () => {
    if (!open) return;
    ops.push({
      op: "replace",
      blockId: base.id,
      from: open.from,
      to: open.from + open.removed.length,
      text: open.inserted,
      baseText: open.removed,
    });
    open = null;
  };

  diffs.forEach(([kind, text], i) => {
    if (kind === DiffMatchPatch.DIFF_EQUAL) {
      const bridgesChanges =
        open !== null && /^\s+$/.test(text) && i < diffs.length - 1;
      if (bridgesChanges && open) {
        open.removed += text;
        open.inserted += text;
      } else {
        close();
      }
      position += text.length;
      return;
    }
    if (!open) open = { from: position, removed: "", inserted: "" };
    if (kind === DiffMatchPatch.DIFF_DELETE) {
      open.removed += text;
      position += text.length;
    } else {
      open.inserted += text;
    }
  });
  close();

  return ops.filter((op) => op.text !== op.baseText);
}

/**
 * The passage as the editor gives it back when nobody touches it. Out of
 * its document a passage can read differently (a nested list item alone
 * comes back at the first level, a line break carries no marks): what an
 * edited block shares with this was never the author's change.
 */
function untouchedPassage(basePassage: Block[]): Map<string, Block> {
  try {
    let n = 0;
    const blocks = editorToBlocks(blocksToEditor(basePassage), () => {
      n += 1;
      return `untouched-${n}`;
    });
    return new Map(blocks.map((block) => [block.id, block]));
  } catch {
    return new Map();
  }
}

/**
 * Whether an ordered item carries on the numbering of the block before it:
 * the editor reads the two as one list (see editorToBlocks).
 */
function joinsList(block: Block, previous: Block | undefined): boolean {
  return (
    block.type === "list_item" &&
    block.list === "ordered" &&
    previous?.type === "list_item" &&
    previous.list === "ordered" &&
    (previous.level ?? 0) === (block.level ?? 0) &&
    markerOf(previous) === markerOf(block)
  );
}

/**
 * Operations for the formatting an author changed on a block edited in
 * place: `textOps` (from diffText) with the marks of their new text where
 * it does not simply take those around it, plus one operation per run of
 * kept text whose marks change, plus one for the block's own format
 * (paragraph, heading level, list...). Line breaks never count: the editor
 * keeps no marks on them.
 */
function formatOps(
  base: Block,
  edited: Block,
  textOps: ReplaceOp[],
  untouched: () => Block | undefined,
  previous: Block | undefined,
): ReplaceOp[] {
  const baseFormat = blockFormatOf(base);
  let nextFormat = blockFormatOf(edited);
  // An image has no text and no format to amend.
  if (!baseFormat || !nextFormat) return textOps;
  // The editor only keeps "starts at 1" on a list right after one it would
  // join. Once the author parts the two, the item comes back without it and
  // still starts at 1: nothing changed for it.
  if (
    baseFormat.start === 1 &&
    nextFormat.type === "list_item" &&
    nextFormat.list === "ordered" &&
    nextFormat.start === undefined &&
    !joinsList(edited, previous)
  ) {
    nextFormat = { ...nextFormat, start: 1 };
  }

  const ops: ReplaceOp[] = [];
  if (!sameBlockFormat(baseFormat, nextFormat)) {
    const echo = untouched();
    const echoFormat = echo ? blockFormatOf(echo) : null;
    if (!echoFormat || !sameBlockFormat(echoFormat, nextFormat)) {
      ops.push({
        op: "replace",
        blockId: base.id,
        from: 0,
        to: 0,
        text: "",
        baseText: "",
        block: nextFormat,
      });
    }
  }

  const text = edited.text;
  const want = markCoverage(edited.marks, text.length);
  const have = markCoverage(mapMarks(base.marks, textOps), text.length);
  let differs = false;
  for (let i = 0; i < text.length && !differs; i += 1) {
    differs = text[i] !== "\n" && !sameFormatAt(want, i, have, i);
  }
  if (!differs) return [...ops, ...textOps];

  // What the editor shows where consolidate would give something else is
  // the author's change, unless the editor reads the base itself that way.
  // That excuse holds per mark type, and only for a type the editor reads
  // differently somewhere in the block: stored marks cut in other pieces
  // than the editor's (an imported text) cover the same characters, but
  // new text typed where two pieces meet would take neither.
  const echo = untouched();
  const sameText = echo !== undefined && echo.text === base.text;
  const echoed = sameText
    ? markCoverage(mapMarks(echo.marks, textOps), text.length)
    : null;
  const readsOtherwise = want.map(() => false);
  if (sameText) {
    const stored = markCoverage(base.marks, base.text.length);
    const read = markCoverage(echo.marks, base.text.length);
    stored.forEach((row, type) => {
      readsOtherwise[type] = row.some(
        (value, i) => base.text[i] !== "\n" && value !== read[type]![i],
      );
    });
  }
  const changed = (i: number) =>
    text[i] !== "\n" &&
    want.some(
      (row, type) =>
        row[i] !== have[type]![i] &&
        !(echoed && readsOtherwise[type] && row[i] === echoed[type]![i]),
    );
  /** What the change at `i` is, so a run holds one kind of change. */
  const changeKey = (i: number) =>
    want.map((row, type) => `${have[type]![i]}>${row[i]}`).join("|");

  // Runs of kept text whose marks change: edited[from, from + length) is
  // base[baseFrom, ...). Line breaks inside a run stay in it.
  const keptText = (baseFrom: number, from: number, length: number) => {
    let start = -1;
    let last = -1;
    const close = () => {
      if (start < 0) return;
      const slice = text.slice(start, last + 1);
      ops.push({
        op: "replace",
        blockId: base.id,
        from: baseFrom + (start - from),
        to: baseFrom + (last + 1 - from),
        text: slice,
        baseText: slice,
        marks: coverageToMarks(want, start, last + 1),
      });
      start = -1;
    };
    for (let i = from; i < from + length; i += 1) {
      if (changed(i)) {
        if (start >= 0 && changeKey(i) !== changeKey(last)) close();
        if (start < 0) start = i;
        last = i;
      } else if (text[i] !== "\n") {
        close();
      }
    }
    close();
  };

  let basePosition = 0;
  let position = 0;
  for (const op of textOps) {
    keptText(basePosition, position, op.from - basePosition);
    position += op.from - basePosition;
    let own = false;
    for (let i = position; i < position + op.text.length && !own; i += 1) {
      own = changed(i);
    }
    ops.push(
      own
        ? {
            ...op,
            marks: coverageToMarks(want, position, position + op.text.length),
          }
        : op,
    );
    position += op.text.length;
    basePosition = op.to;
  }
  keptText(basePosition, position, base.text.length - basePosition);
  return ops;
}

/**
 * `edited` without the `start` a base item only takes over from the deleted
 * items before it: with them gone, consolidate gives it that number anyway
 * (handedOnListStarts), so it is no change of format. `stored` keeps the
 * start an item's base text already gives it.
 */
function handedOverStarts(
  before: readonly Block[],
  basePassage: readonly Block[],
  edited: Block[],
  stored: (block: Block) => boolean,
): Block[] {
  const editedIds = new Set(edited.map((block) => block.id));
  const passageIds = new Set(basePassage.map((block) => block.id));
  const handed = handedOnListStarts(
    [...before, ...basePassage],
    (block) => !passageIds.has(block.id) || editedIds.has(block.id),
  );
  if (handed.size === 0) return edited;
  return edited.map((block) => {
    if (
      block.start === undefined ||
      block.start !== handed.get(block.id) ||
      stored(block)
    ) {
      return block;
    }
    const copy: Block = { ...block };
    delete copy.start;
    return copy;
  });
}

/**
 * Turns an edited passage into amendment operations.
 *
 * `basePassage` is a run of consecutive base blocks; `edited` is what the
 * author left after editing it. Blocks keep their ids when edited in place,
 * new blocks carry fresh ids, and missing ones are deleted. `anchorBefore` is
 * the base block right before the passage (null at the start of the document).
 * A block moved out of order is treated as deleted and re-inserted, because
 * operations do not express moves.
 *
 * A block edited in place may change its text, its inline formatting and
 * its own format (see formatOps); the cell it sits in and an image's
 * picture are not compared.
 *
 * `before`, the base blocks before the passage, is for an editor seeded
 * with the passage's real list numbers (seedListStarts): a `start` that
 * only says the number an item shows there anyway is no change. Nor is the
 * start an item takes over from a deleted one that carried it (the editor
 * moves a list's start to its new first item): consolidate hands it on.
 */
export function diffPassage(
  basePassage: Block[],
  editedPassage: Block[],
  anchorBefore: string | null,
  newId: () => string,
  before?: readonly Block[],
): AmendmentOp[] {
  const baseById = new Map(basePassage.map((block) => [block.id, block]));
  const baseOrder = new Map(basePassage.map((block, i) => [block.id, i]));
  const kept = new Set<string>();
  const replaces: ReplaceOp[] = [];
  const inserts: InsertOp[] = [];
  const stored = (block: Block) => baseById.get(block.id)?.start !== undefined;
  const handed = handedOverStarts(
    before ?? [],
    basePassage,
    editedPassage,
    stored,
  );
  const edited = before ? withoutImpliedStarts(before, handed, stored) : handed;

  let untouched: Map<string, Block> | null = null;
  const untouchedOf = (id: string) => {
    // Seeded with its numbers, the passage comes back from the editor so.
    untouched ??= untouchedPassage(
      before ? seedListStarts(before, basePassage) : basePassage,
    );
    return untouched.get(id);
  };

  let anchor = anchorBefore;
  let lastIndex = -1;
  let pending: Block[] = [];
  /** The block before the one being read, as the author left it. */
  let previous: Block | undefined;
  const flush = () => {
    if (pending.length > 0) {
      inserts.push({ op: "insert", afterBlockId: anchor, blocks: pending });
      pending = [];
    }
  };

  for (const block of edited) {
    const previousEdited = previous;
    previous = block;
    const original = baseById.get(block.id);
    const order = baseOrder.get(block.id);
    if (
      original &&
      order !== undefined &&
      order > lastIndex &&
      !kept.has(block.id)
    ) {
      flush();
      kept.add(block.id);
      lastIndex = order;
      anchor = block.id;
      replaces.push(
        ...formatOps(
          original,
          block,
          diffText(original, block.text),
          () => untouchedOf(block.id),
          previousEdited,
        ),
      );
      continue;
    }
    const fresh = original ? { ...block, id: newId() } : block;
    // A blank cell still holds its place in its row; an image has no text.
    if (fresh.text.trim() !== "" || fresh.cell || fresh.type === "image") {
      pending.push(fresh);
    }
  }
  flush();

  const removed = basePassage
    .filter((block) => !kept.has(block.id))
    .map((block) => block.id);
  const deletes: DeleteOp[] =
    removed.length > 0 ? [{ op: "delete", blockIds: removed }] : [];

  return [...replaces, ...deletes, ...inserts];
}

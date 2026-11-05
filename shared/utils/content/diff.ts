import DiffMatchPatch from "diff-match-patch";
import type {
  AmendmentOp,
  Block,
  DeleteOp,
  InsertOp,
  ReplaceOp,
} from "../../types/content";

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
 * Turns an edited passage into amendment operations.
 *
 * `basePassage` is a run of consecutive base blocks; `edited` is what the
 * author left after editing it. Blocks keep their ids when edited in place,
 * new blocks carry fresh ids, and missing ones are deleted. `anchorBefore` is
 * the base block right before the passage (null at the start of the document).
 * A block moved out of order is treated as deleted and re-inserted, because
 * operations do not express moves.
 */
export function diffPassage(
  basePassage: Block[],
  edited: Block[],
  anchorBefore: string | null,
  newId: () => string,
): AmendmentOp[] {
  const baseById = new Map(basePassage.map((block) => [block.id, block]));
  const baseOrder = new Map(basePassage.map((block, i) => [block.id, i]));
  const kept = new Set<string>();
  const replaces: ReplaceOp[] = [];
  const inserts: InsertOp[] = [];

  let anchor = anchorBefore;
  let lastIndex = -1;
  let pending: Block[] = [];
  const flush = () => {
    if (pending.length > 0) {
      inserts.push({ op: "insert", afterBlockId: anchor, blocks: pending });
      pending = [];
    }
  };

  for (const block of edited) {
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
      replaces.push(...diffText(original, block.text));
      continue;
    }
    const fresh = original ? { ...block, id: newId() } : block;
    if (fresh.text.trim() !== "") pending.push(fresh);
  }
  flush();

  const removed = basePassage
    .filter((block) => !kept.has(block.id))
    .map((block) => block.id);
  const deletes: DeleteOp[] =
    removed.length > 0 ? [{ op: "delete", blockIds: removed }] : [];

  return [...replaces, ...deletes, ...inserts];
}

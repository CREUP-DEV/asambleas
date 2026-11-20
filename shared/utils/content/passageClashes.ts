import type {
  AmendmentInput,
  AmendmentOp,
  Block,
  ReplaceOp,
} from "../../types/content";

/**
 * What the Mesa needs to word a passage where approved amendments collide
 * (user's decision of 2026-11-20): where exactly they clash, what each one
 * puts there, and how much of each a wording keeps. Pure, shared by the
 * session console's wording dialog and its tests.
 */

/** One amendment's version of a clash. */
export interface ClashProposal {
  amendmentId: string;
  /**
   * Its changes inside the clash, as replace operations over `base` (the
   * clash's own base block): ready for the amendment diff.
   */
  ops: ReplaceOp[];
  /** It deletes the whole paragraph the clash is in. */
  deletes: boolean;
}

/**
 * A stretch of one base block that two or more amendments change: the
 * union of their touching changes.
 */
export interface PassageClash {
  key: string;
  blockId: string;
  from: number;
  to: number;
  /**
   * The base text of the stretch as a block of its own (id `key`), so each
   * proposal reads as a diff over just this stretch.
   */
  base: Block;
  proposals: ClashProposal[];
}

interface Span {
  amendmentId: string;
  from: number;
  to: number;
  op: ReplaceOp | null;
}

/** Ranges that overlap or meet (a change right where another ends). */
function spansTouch(a: Span, b: Span): boolean {
  return a.from <= b.to && b.from <= a.to;
}

function passageOps(ops: AmendmentOp[], blockIds: Set<string>): AmendmentOp[] {
  return ops.filter((op) => {
    if (op.op === "replace") return blockIds.has(op.blockId);
    if (op.op === "delete") return op.blockIds.some((id) => blockIds.has(id));
    return op.afterBlockId === null || blockIds.has(op.afterBlockId);
  });
}

/** An amendment's operations that act on the passage's blocks. */
export function amendmentPassageOps(
  amendment: AmendmentInput,
  blockIds: readonly string[],
): AmendmentOp[] {
  return passageOps(amendment.ops, new Set(blockIds));
}

/**
 * Where the amendments of a passage clash, block by block in the order of
 * the base: each stretch two or more of them change (their changes overlap
 * or meet), with what each one puts there. A change of a whole block's
 * format, or its deletion, takes the whole block.
 */
export function passageClashes(
  base: readonly Block[],
  amendments: readonly AmendmentInput[],
  blockIds: readonly string[],
): PassageClash[] {
  const wanted = new Set(blockIds);
  const clashes: PassageClash[] = [];
  for (const block of base) {
    if (!wanted.has(block.id)) continue;
    const spans: Span[] = [];
    const deleting = new Set<string>();
    for (const amendment of amendments) {
      for (const op of amendment.ops) {
        if (op.op === "replace" && op.blockId === block.id) {
          spans.push(
            op.block !== undefined
              ? {
                  amendmentId: amendment.id,
                  from: 0,
                  to: block.text.length,
                  op: null,
                }
              : { amendmentId: amendment.id, from: op.from, to: op.to, op },
          );
        } else if (op.op === "delete" && op.blockIds.includes(block.id)) {
          deleting.add(amendment.id);
          spans.push({
            amendmentId: amendment.id,
            from: 0,
            to: block.text.length,
            op: null,
          });
        }
      }
    }
    spans.sort((a, b) => a.from - b.from || a.to - b.to);
    // Touching spans form one stretch; a stretch is a clash with 2+ authors.
    const groups: Span[][] = [];
    for (const span of spans) {
      const last = groups.at(-1);
      if (last && last.some((other) => spansTouch(other, span))) {
        last.push(span);
      } else {
        groups.push([span]);
      }
    }
    for (const group of groups) {
      // In the order of the passage, so each keeps its colour.
      const inGroup = new Set(group.map((span) => span.amendmentId));
      const ids = amendments
        .map((amendment) => amendment.id)
        .filter((id) => inGroup.has(id));
      if (ids.length < 2) continue;
      const from = Math.min(...group.map((span) => span.from));
      const to = Math.max(...group.map((span) => span.to));
      const key = `clash-${block.id}-${from}`;
      clashes.push({
        key,
        blockId: block.id,
        from,
        to,
        base: {
          id: key,
          type: "paragraph",
          text: block.text.slice(from, to),
          marks: [],
        },
        proposals: ids.map((amendmentId) => ({
          amendmentId,
          deletes: deleting.has(amendmentId),
          ops: group
            .filter((span) => span.amendmentId === amendmentId && span.op)
            .map((span) => {
              const { block: _format, ...op } = span.op!;
              return {
                ...op,
                blockId: key,
                from: op.from - from,
                to: op.to - from,
              };
            }),
        })),
      });
    }
  }
  return clashes;
}

// How much of each amendment a wording keeps --------------------------------------

export type PassageCoverage = "all" | "part" | "none";

const WORD = /[\p{L}\p{N}]/u;

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => WORD.test(word));
}

function counts(list: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const word of list) map.set(word, (map.get(word) ?? 0) + 1);
  return map;
}

/**
 * How much of what an amendment changes in the passage a wording keeps,
 * word by word: for each word, how many more (or fewer) times the
 * amendment has it than the base, against how many more (or fewer) the
 * wording has. Net counts, so a rewrite that takes "la" away in one place
 * and puts it back in another counts once. A count, not an exact
 * comparison: enough to say "all", "part" or "none".
 */
export function passageCoverage(
  baseText: string,
  amendmentText: string,
  wordingText: string,
): PassageCoverage {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  if (flat(wordingText) === flat(amendmentText)) return "all";
  const inBase = counts(words(baseText));
  const inAmendment = counts(words(amendmentText));
  const inWording = counts(words(wordingText));
  let total = 0;
  let kept = 0;
  for (const word of new Set([...inBase.keys(), ...inAmendment.keys()])) {
    const before = inBase.get(word) ?? 0;
    const wanted = (inAmendment.get(word) ?? 0) - before;
    if (wanted === 0) continue;
    const got = (inWording.get(word) ?? 0) - before;
    total += Math.abs(wanted);
    kept +=
      wanted > 0
        ? Math.min(Math.max(got, 0), wanted)
        : Math.min(Math.max(-got, 0), -wanted);
  }
  // Only punctuation or order changes: the wording either is the base or not.
  if (total === 0) {
    return flat(wordingText) === flat(baseText) ? "none" : "part";
  }
  const share = kept / total;
  if (share >= 0.9) return "all";
  if (share <= 0.1) return "none";
  return "part";
}

/** The plain text of some blocks, a line each. */
export function blocksPlainText(blocks: readonly Block[]): string {
  return blocks.map((block) => block.text).join("\n");
}

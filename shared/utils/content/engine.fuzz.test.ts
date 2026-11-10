import { describe, expect, it } from "vitest";
import type {
  AmendmentInput,
  AmendmentOp,
  Block,
  BlockFormat,
  BlockType,
  ConsolidatedBlock,
  ConsolidationResult,
  Mark,
  ReplaceOp,
} from "../../types/content";
import { BLOCK_ALIGNMENTS, MARK_TYPES } from "../../types/content";
import { consolidate, mapPosition } from "./consolidate";
import { diffPassage } from "./diff";
import { blocksToEditor, editorToBlocks } from "./editor";
import {
  blockFormatOf,
  coverageToMarks,
  markCoverage,
  sameBlockFormat,
} from "./format";
import { compareReplaceOps, validateOps } from "./ops";
import {
  findOverlaps,
  isHardOverlap,
  overlapBetween,
  type OverlapKind,
  type OverlapReport,
} from "./overlaps";
import { renderAnnotated, renderBlocks } from "./render";

/**
 * Property-based tests of the amendment engine.
 *
 * Every property runs a few hundred deterministic cases from a seeded PRNG.
 * A failure reports its seed and the generated input. To rerun one seed:
 *
 *   FUZZ_SEED=<seed> pnpm exec vitest run shared/utils/content/engine.fuzz.test.ts
 *
 * Defects the properties found are pinned at the end of the file as minimal
 * reproductions. FUZZ_ALL_FAILURES=1 lists every failing seed, with the tags
 * a property records, instead of stopping at the first one:
 *
 *   FUZZ_ALL_FAILURES=1 pnpm exec vitest run ...
 *
 * Each property also counts the situations it is meant to exercise and
 * fails when a generator change leaves them too rare.
 */

// ---------------------------------------------------------------------------
// Seeded randomness

/** mulberry32: tiny and good enough to drive generators. */
class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }
}

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {};
const ONLY_SEED = env.FUZZ_SEED ? Number(env.FUZZ_SEED) : null;
const ALL_FAILURES = env.FUZZ_ALL_FAILURES === "1";

type Context = Record<string, unknown>;

/**
 * Runs `property` once per seed. On failure the error message is prefixed
 * with the seed and the input the property stored in `ctx`.
 */
function forAll(
  runs: number,
  firstSeed: number,
  property: (rng: Rng, ctx: Context) => void,
): void {
  const seeds =
    ONLY_SEED !== null
      ? [ONLY_SEED]
      : Array.from({ length: runs }, (_, i) => firstSeed + i);
  const failures: string[] = [];
  for (const seed of seeds) {
    const ctx: Context = {};
    try {
      property(new Rng(seed), ctx);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (ALL_FAILURES) {
        // Boolean entries of ctx are tags that help classify failures.
        const tags = Object.entries(ctx)
          .filter(([, value]) => typeof value === "boolean")
          .map(([key, value]) => `${key}=${String(value)}`);
        const reason = error.message.split("\n")[0]!.slice(0, 160);
        failures.push(`[seed ${seed}] ${tags.join(" ")} ${reason}`);
        continue;
      }
      const input = JSON.stringify(ctx);
      const shown = input.length > 8000 ? `${input.slice(0, 8000)}...` : input;
      error.message = `[seed ${seed}] ${error.message}\ninput: ${shown}`;
      throw error;
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} failing seeds:\n${failures.join("\n")}`,
    );
  }
}

/**
 * Counts how often a property met each situation it is meant to exercise,
 * so a generator change cannot quietly turn a property into a no-op. The
 * minimums apply to full runs only, not to a single FUZZ_SEED.
 */
class Coverage {
  private readonly counts = new Map<string, number>();

  hit(label: string, condition = true): void {
    if (condition) this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
  }

  expectAtLeast(minimums: Record<string, number>): void {
    if (ONLY_SEED !== null) return;
    const seen = Object.fromEntries(
      Object.keys(minimums).map((label) => [
        label,
        this.counts.get(label) ?? 0,
      ]),
    );
    for (const [label, minimum] of Object.entries(minimums)) {
      expect(
        seen[label],
        `coverage of "${label}" (${JSON.stringify(seen)})`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  }
}

/** True when some key is produced by two or more of the items. */
function sharesKey<T>(items: T[], keysOf: (item: T) => string[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const keys = new Set(keysOf(item));
    for (const key of keys) if (seen.has(key)) return true;
    keys.forEach((key) => seen.add(key));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Content generators

const WORDS = [
  "el",
  "la",
  "de",
  "los",
  "y",
  "en",
  "créditos",
  "año",
  "beca",
  "ayuda",
  "alumnado",
  "deberá",
  "Universidad",
  "naïve",
  "éxito", // decomposed accent: combining mark after a letter
  "50",
  "%",
  "«",
  "»",
  "¿",
  "?",
  "¡",
  "!",
  ",",
  ".",
  ";",
  ":",
  "(",
  ")",
  "\u{1F600}",
  "\u{1F44D}\u{1F3FD}", // emoji with skin tone modifier
  "\u{1F468}‍\u{1F469}‍\u{1F467}", // ZWJ family sequence
  "\u{1F1EA}\u{1F1F8}", // flag
  "<",
  ">",
  "&",
  '"',
  "'",
  "<b>",
  "&amp;",
] as const;

const HOSTILE_WORDS = [
  ...WORDS,
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "&lt;",
  "&#60;",
  "javascript:alert(1)",
  '"><b>',
  "<!--",
  "]]>",
];

const SEPARATORS = [" ", " ", " ", " ", "", "  ", "\n", " \n"] as const;
const CHARS = ["a", "é", "\u{1F600}", " ", "<", "&", "\n", "́"] as const;
const LIST_STYLES = ["bullet", "ordered"] as const;

const SAFE_HREFS = ["https://creup.es", "mailto:someone@example.com"];
const HOSTILE_HREFS: (string | undefined)[] = [
  "https://creup.es/a?b=1&c=2",
  "HTTP://EXAMPLE.ORG",
  "mailto:someone@example.com",
  "  https://padded.example  ",
  "javascript:alert(1)",
  " javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "java\tscript:alert(1)",
  "\u0000javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  'https://x" onmouseover="alert(1)',
  "//evil.example",
  "",
  undefined,
];
const HOSTILE_IDS = ['x"><script>alert(1)</script>', "a'b", "c&d", "<e>"];

interface ContentOptions {
  words?: readonly string[];
  hrefs?: readonly (string | undefined)[];
  maxWords?: number;
  maxMarks?: number;
}

function phrase(
  rng: Rng,
  min: number,
  max: number,
  words: readonly string[] = WORDS,
): string {
  let text = "";
  for (let i = rng.int(min, max); i > 0; i -= 1) {
    if (text !== "") text += rng.pick(SEPARATORS);
    text += rng.pick(words);
  }
  return text;
}

function randomText(rng: Rng, options: ContentOptions = {}): string {
  if (rng.chance(0.05)) return "";
  const text = phrase(rng, 1, options.maxWords ?? 8, options.words);
  if (rng.chance(0.1)) return ` ${text}`;
  if (rng.chance(0.1)) return `${text} `;
  return text;
}

/** Offsets of every code point boundary, 0 and text.length included. */
function codePointOffsets(text: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const char of text) {
    offset += char.length;
    offsets.push(offset);
  }
  return offsets;
}

/** Offsets between whitespace runs and words, 0 and text.length included. */
function wordOffsets(text: string): number[] {
  const offsets = [0];
  for (const match of text.matchAll(/\s+|\S+/g)) {
    offsets.push((match.index ?? 0) + match[0].length);
  }
  return offsets;
}

function randomMarks(
  rng: Rng,
  text: string,
  options: ContentOptions = {},
): Mark[] {
  const offsets = codePointOffsets(text);
  if (offsets.length < 2) return [];
  const marks: Mark[] = [];
  let linked = false;
  for (let n = rng.int(0, options.maxMarks ?? 3); n > 0; n -= 1) {
    const a = rng.int(0, offsets.length - 2);
    const b = rng.int(a + 1, offsets.length - 1);
    let type = rng.pick(MARK_TYPES);
    // At most one link per block: overlapping links have no single rendering.
    if (type === "link" && linked) type = "bold";
    const mark: Mark = { type, from: offsets[a]!, to: offsets[b]! };
    if (type === "link") {
      linked = true;
      const href = rng.pick(options.hrefs ?? SAFE_HREFS);
      if (href !== undefined) mark.href = href;
    }
    marks.push(mark);
  }
  return marks;
}

function randomBlock(
  rng: Rng,
  id: string,
  options: ContentOptions = {},
): Block {
  const roll = rng.next();
  const type: BlockType =
    roll < 0.5
      ? "paragraph"
      : roll < 0.65
        ? "heading"
        : roll < 0.85
          ? "list_item"
          : "quote";
  const text = randomText(rng, options);
  const block: Block = {
    id,
    type,
    text,
    marks: randomMarks(rng, text, options),
  };
  if (type === "heading") block.level = rng.int(1, 4);
  if (type === "list_item") {
    block.level = rng.int(0, 2);
    block.list = rng.pick(LIST_STYLES);
  }
  return block;
}

function randomDocument(
  rng: Rng,
  min: number,
  max: number,
  options: ContentOptions = {},
): Block[] {
  return Array.from({ length: rng.int(min, max) }, (_, i) =>
    randomBlock(rng, `base${i}`, options),
  );
}

function idSequence(prefix: string): () => string {
  let next = 0;
  return () => {
    const id = `${prefix}${next}`;
    next += 1;
    return id;
  };
}

function cloneBlock(block: Block): Block {
  return { ...block, marks: block.marks.map((mark) => ({ ...mark })) };
}

/**
 * The block with new text. Marks are clipped to it, as the editor and the
 * block schema guarantee for any block an author submits.
 */
function withText(block: Block, text: string): Block {
  return { ...block, text, marks: sliceMarks(block.marks, 0, text.length) };
}

/** Marks of text[from, to), shifted so `from` becomes 0. */
function sliceMarks(marks: Mark[], from: number, to: number): Mark[] {
  return marks
    .map((mark) => ({
      ...mark,
      from: Math.max(mark.from, from) - from,
      to: Math.min(mark.to, to) - from,
    }))
    .filter((mark) => mark.from < mark.to);
}

/** The block with the format of another random block, its text kept. */
function withFormat(rng: Rng, block: Block): Block {
  const shape = randomBlock(rng, block.id);
  const next: Block = {
    id: block.id,
    type: shape.type,
    text: block.text,
    marks: block.marks,
  };
  if (shape.level !== undefined) next.level = shape.level;
  if (shape.list !== undefined) next.list = shape.list;
  if (next.list === "ordered") {
    if (rng.chance(0.3)) next.marker = rng.pick(["a)", "I.", "1)"] as const);
    if (rng.chance(0.3)) next.start = rng.int(1, 9);
  }
  if (rng.chance(0.25)) next.align = rng.pick(BLOCK_ALIGNMENTS);
  return next;
}

// ---------------------------------------------------------------------------
// Passage edits, as an author would make them in the editor

const EDITS = [
  "words",
  "words",
  "words",
  "chars",
  "rewrite",
  "delete",
  "insert",
  "split",
  "merge",
  "move",
  "duplicate",
  "marks",
  "marks",
  "format",
] as const;

function mutateWords(
  rng: Rng,
  text: string,
  words: readonly string[] = WORDS,
): string {
  const tokens = text.match(/\s+|\S+/g) ?? [];
  for (let n = rng.int(1, 3); n > 0; n -= 1) {
    const at = rng.int(0, tokens.length);
    const action =
      tokens.length === 0
        ? "insert"
        : rng.pick(["replace", "delete", "insert"] as const);
    if (action === "insert") {
      tokens.splice(at, 0, rng.pick(SEPARATORS) || " ", rng.pick(words));
      continue;
    }
    const index = Math.min(at, tokens.length - 1);
    if (action === "replace") tokens[index] = rng.pick(words);
    else tokens.splice(index, 1);
  }
  return tokens.join("");
}

function mutateChars(rng: Rng, text: string): string {
  const offsets = codePointOffsets(text);
  const k = rng.int(0, offsets.length - 1);
  const at = offsets[k]!;
  if (k < offsets.length - 1 && rng.chance(0.5)) {
    return text.slice(0, at) + text.slice(offsets[k + 1]!);
  }
  return text.slice(0, at) + rng.pick(CHARS) + text.slice(at);
}

/**
 * Applies 1-4 random edits to a copy of `passage`: word and character edits,
 * rewrites, deleted, inserted, split, merged, moved and duplicated blocks,
 * new inline marks and a new block format (type, level, list, alignment).
 * Text edits leave the marks where they were, clipped to the new text, so
 * most of them change the formatting of some text too.
 */
function editPassage(
  rng: Rng,
  passage: Block[],
  freshId: () => string,
  options: ContentOptions = {},
): Block[] {
  const edited = passage.map(cloneBlock);
  const passageIds = new Set(passage.map((block) => block.id));
  for (let n = rng.int(1, 4); n > 0; n -= 1) {
    const edit = rng.pick(EDITS);
    if (edited.length === 0 || edit === "insert") {
      edited.splice(
        rng.int(0, edited.length),
        0,
        randomBlock(rng, freshId(), options),
      );
      continue;
    }
    const i = rng.int(0, edited.length - 1);
    const block = edited[i]!;
    switch (edit) {
      case "words":
        edited[i] = withText(
          block,
          mutateWords(rng, block.text, options.words),
        );
        break;
      case "chars":
        edited[i] = withText(block, mutateChars(rng, block.text));
        break;
      case "rewrite":
        edited[i] = withText(block, phrase(rng, 0, 6, options.words));
        break;
      case "delete":
        edited.splice(i, 1);
        break;
      case "split": {
        const cut = rng.pick(codePointOffsets(block.text));
        const length = block.text.length;
        edited.splice(
          i,
          1,
          {
            ...block,
            text: block.text.slice(0, cut),
            marks: sliceMarks(block.marks, 0, cut),
          },
          {
            ...block,
            id: freshId(),
            text: block.text.slice(cut),
            marks: sliceMarks(block.marks, cut, length),
          },
        );
        break;
      }
      case "merge": {
        const next = edited[i + 1];
        if (!next) break;
        const separator = rng.pick(["", " ", "\n"] as const);
        const offset = block.text.length + separator.length;
        edited.splice(i, 2, {
          ...block,
          text: block.text + separator + next.text,
          marks: [
            ...block.marks,
            ...next.marks.map((mark) => ({
              ...mark,
              from: mark.from + offset,
              to: mark.to + offset,
            })),
          ],
        });
        break;
      }
      case "move": {
        edited.splice(i, 1);
        edited.splice(rng.int(0, edited.length), 0, block);
        break;
      }
      case "marks":
        edited[i] = { ...block, marks: randomMarks(rng, block.text, options) };
        break;
      case "format":
        edited[i] = withFormat(rng, block);
        break;
      case "duplicate": {
        // Only base ids repeat here, to exercise diffPassage's handling of
        // them; any other copy gets a fresh id, as the editor would give it.
        const copy = cloneBlock(block);
        if (!passageIds.has(copy.id)) copy.id = freshId();
        edited.splice(rng.int(0, edited.length), 0, copy);
        break;
      }
    }
  }
  return edited;
}

// ---------------------------------------------------------------------------
// Amendment generators

function passageOps(
  rng: Rng,
  base: Block[],
  freshId: () => string,
  options: ContentOptions,
): AmendmentOp[] {
  const start = rng.int(0, base.length - 1);
  const end = rng.int(start + 1, Math.min(base.length, start + 3));
  const passage = base.slice(start, end);
  const anchorBefore = start > 0 ? base[start - 1]!.id : null;
  return diffPassage(
    passage,
    editPassage(rng, passage, freshId, options),
    anchorBefore,
    freshId,
  );
}

function directOps(
  rng: Rng,
  base: Block[],
  freshId: () => string,
  options: ContentOptions,
): AmendmentOp[] {
  const ops: AmendmentOp[] = [];
  for (let n = rng.int(1, 3); n > 0; n -= 1) {
    const roll = rng.next();
    if (roll < 0.6) {
      const block = rng.pick(base);
      const offsets = rng.chance(0.7)
        ? wordOffsets(block.text)
        : codePointOffsets(block.text);
      const from = rng.pick(offsets);
      const to = rng.chance(0.3)
        ? from
        : rng.pick(offsets.filter((offset) => offset >= from));
      const formatRoll = rng.next();
      if (formatRoll < 0.1) {
        // A new format for the whole block.
        const format = blockFormatOf(withFormat(rng, block));
        if (format) {
          ops.push({
            op: "replace",
            blockId: block.id,
            from: 0,
            to: 0,
            text: "",
            baseText: "",
            block: format,
          });
        }
        continue;
      }
      if (formatRoll < 0.25 && from < to) {
        // New marks for text that stays.
        const kept = block.text.slice(from, to);
        ops.push({
          op: "replace",
          blockId: block.id,
          from,
          to,
          text: kept,
          baseText: kept,
          marks: randomMarks(rng, kept, options),
        });
        continue;
      }
      if (formatRoll < 0.4) {
        // New text with marks of its own.
        const text = phrase(rng, 1, 3, options.words);
        ops.push({
          op: "replace",
          blockId: block.id,
          from,
          to,
          text,
          baseText: block.text.slice(from, to),
          marks: randomMarks(rng, text, options),
        });
        continue;
      }
      ops.push({
        op: "replace",
        blockId: block.id,
        from,
        to,
        text: rng.chance(0.2) ? "" : phrase(rng, 1, 3, options.words),
        baseText: block.text.slice(from, to),
      });
    } else if (roll < 0.8) {
      ops.push({
        op: "insert",
        afterBlockId: rng.chance(0.2) ? null : rng.pick(base).id,
        blocks: Array.from({ length: rng.int(1, 2) }, () =>
          randomBlock(rng, freshId(), options),
        ),
      });
    } else {
      const ids = rng.shuffle(base.map((block) => block.id));
      ops.push({ op: "delete", blockIds: ids.slice(0, rng.int(1, 2)) });
    }
  }
  return ops;
}

/** Valid operations for one amendment, from a passage edit or built directly. */
function randomOps(
  rng: Rng,
  base: Block[],
  freshId: () => string,
  options: ContentOptions,
): AmendmentOp[] | null {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ops = rng.chance(0.5)
      ? passageOps(rng, base, freshId, options)
      : directOps(rng, base, freshId, options);
    if (ops.length > 0 && validateOps(base, ops).length === 0) return ops;
  }
  return null;
}

/** Amendments over the same base, overlapping each other freely. */
function randomAmendments(
  rng: Rng,
  base: Block[],
  count: number,
  options: ContentOptions = {},
  freshId: () => string = idSequence("ins"),
  amendmentId: (index: number) => string = (index) => `am${index}`,
): AmendmentInput[] {
  const amendments: AmendmentInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const ops = randomOps(rng, base, freshId, options);
    if (ops) amendments.push({ id: amendmentId(amendments.length), ops });
  }
  return amendments;
}

function isReplace(op: AmendmentOp): op is ReplaceOp {
  return op.op === "replace";
}

/**
 * The operations as they were stored before formatting could be amended:
 * replacements of text alone, with no marks and no block format.
 */
function textOnly(ops: AmendmentOp[]): AmendmentOp[] {
  return ops.flatMap((op): AmendmentOp[] => {
    if (op.op !== "replace") return [op];
    if (op.block !== undefined || op.text === op.baseText) return [];
    return [
      {
        op: "replace",
        blockId: op.blockId,
        from: op.from,
        to: op.to,
        text: op.text,
        baseText: op.baseText,
      },
    ];
  });
}

/** Keys an amendment's operations act on: blocks it edits or removes. */
function blockKeys(amendment: AmendmentInput): string[] {
  return amendment.ops.flatMap((op) =>
    op.op === "replace" ? [op.blockId] : op.op === "delete" ? op.blockIds : [],
  );
}

/** Anchors an amendment inserts after. */
function anchorKeys(amendment: AmendmentInput): string[] {
  return amendment.ops.flatMap((op) =>
    op.op === "insert" ? [op.afterBlockId ?? "(start)"] : [],
  );
}

// ---------------------------------------------------------------------------
// Consolidation checks

function assertMarksInBounds(text: string, marks: Mark[], where: string) {
  for (const mark of marks) {
    const valid =
      Number.isInteger(mark.from) &&
      Number.isInteger(mark.to) &&
      mark.from >= 0 &&
      mark.from < mark.to &&
      mark.to <= text.length;
    if (!valid) {
      throw new Error(
        `${where}: mark ${JSON.stringify(mark)} outside ${JSON.stringify(text)}`,
      );
    }
  }
}

/** Property 4 plus the agreement between annotated and clean output. */
function assertWellFormed(result: ConsolidationResult): void {
  for (const block of result.blocks) {
    assertMarksInBounds(block.text, block.marks, `block ${block.id}`);
  }
  for (const block of result.annotated) {
    const clean = block.segments
      .filter((segment) => !segment.removed)
      .map((segment) => segment.text)
      .join("");
    assertMarksInBounds(clean, block.marks, `annotated ${block.id}`);
  }
  const visible = result.annotated.filter(
    (block) => block.status !== "deleted",
  );
  expect(
    visible.map((block) => ({
      id: block.id,
      text: block.segments
        .filter((segment) => !segment.removed)
        .map((segment) => segment.text)
        .join(""),
    })),
  ).toEqual(result.blocks.map((block) => ({ id: block.id, text: block.text })));
}

/**
 * How a block of the edited passage should look after consolidation. A kept
 * block shows its format (`format` when the caller knows better which) and
 * the formatting of each of its characters, line breaks aside: operations
 * carry both, but not the way the marks were cut. A new block is stored as
 * it came.
 */
function passageView(
  block: Block,
  kept: boolean,
  isFreshId: (id: string) => boolean,
  format: BlockFormat | null = blockFormatOf(block),
) {
  return {
    kept,
    id: kept ? block.id : isFreshId(block.id) ? "(fresh id)" : block.id,
    format: kept
      ? format
      : { type: block.type, level: block.level, list: block.list },
    text: block.text,
    marks: kept ? formatsByChar(block) : block.marks,
  };
}

/**
 * Annotated output with the blocks inserted between two base blocks grouped
 * by amendment, groups sorted by amendment id: the only part of the output
 * that legitimately depends on the order amendments are applied in.
 */
function canonicalOrder(annotated: ConsolidatedBlock[]): ConsolidatedBlock[] {
  const out: ConsolidatedBlock[] = [];
  let gap = new Map<string, ConsolidatedBlock[]>();
  const flush = () => {
    for (const source of [...gap.keys()].sort()) out.push(...gap.get(source)!);
    gap = new Map();
  };
  for (const block of annotated) {
    if (block.status === "inserted") {
      const source = block.source ?? "";
      gap.set(source, [...(gap.get(source) ?? []), block]);
    } else {
      flush();
      out.push(block);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Overlap checks

function pairKey(a: string, b: string): string {
  return a < b ? `${a} | ${b}` : `${b} | ${a}`;
}

function pairTable(
  pairs: { a: string; b: string; kind: OverlapKind }[],
): [string, OverlapKind][] {
  return pairs
    .map((pair): [string, OverlapKind] => [pairKey(pair.a, pair.b), pair.kind])
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
}

function canonicalClusters(report: OverlapReport): string[][] {
  return report.clusters
    .map((cluster) => [...cluster].sort())
    .sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
}

/** Clusters are the connected components of the overlap graph. */
function assertClusters(report: OverlapReport): void {
  const involved = new Set(report.pairs.flatMap((pair) => [pair.a, pair.b]));
  const owner = new Map<string, number>();
  report.clusters.forEach((cluster, index) => {
    expect(cluster.length).toBeGreaterThanOrEqual(2);
    for (const id of cluster) {
      expect(owner.has(id), `${id} is in two clusters`).toBe(false);
      owner.set(id, index);
    }
  });
  expect([...owner.keys()].sort()).toEqual([...involved].sort());

  const neighbours = new Map<string, string[]>();
  for (const pair of report.pairs) {
    expect(owner.get(pair.a)).toBe(owner.get(pair.b));
    neighbours.set(pair.a, [...(neighbours.get(pair.a) ?? []), pair.b]);
    neighbours.set(pair.b, [...(neighbours.get(pair.b) ?? []), pair.a]);
  }
  for (const cluster of report.clusters) {
    const reached = new Set([cluster[0]!]);
    const queue = [cluster[0]!];
    while (queue.length > 0) {
      for (const next of neighbours.get(queue.shift()!) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect([...reached].sort()).toEqual([...cluster].sort());
  }
}

// ---------------------------------------------------------------------------
// HTML checks

const TAG = /<(\/?)([a-z][a-z0-9]*)((?:\s[a-z-]+="[^"]*")*)>/y;
const ATTRIBUTE = /\s([a-z-]+)="([^"]*)"/g;
const ALLOWED_TAGS = new Set([
  "p",
  "h2",
  "h3",
  "h4",
  "h5",
  "ul",
  "ol",
  "li",
  "blockquote",
  "strong",
  "em",
  "u",
  "s",
  "a",
  "br",
  "del",
  "ins",
  "span",
  "sup",
]);
const ALLOWED_ATTRIBUTES = new Set([
  "data-block-id",
  "data-amendment-id",
  "class",
  "href",
  "rel",
  "target",
  "aria-hidden",
  "start",
  "data-marker",
]);
const FORMAT_TAGS: Record<string, string> = {
  strong: "bold",
  em: "italic",
  u: "underline",
  s: "strike",
};
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

interface RenderedChar {
  char: string;
  /** Formatting tags around the character, as mark types or `link:<href>`. */
  formats: string[];
  /** Inside <del>. */
  removed: boolean;
  /** Inside a provenance <sup> label or the words a diff adds. */
  label: boolean;
}

interface Scan {
  chars: RenderedChar[];
  hrefs: string[];
  blockIds: string[];
  amendmentIds: string[];
  breaks: number;
}

function decodeEntities(raw: string, where: string): string {
  if (/&(?!(?:amp|lt|gt|quot|#39);)/.test(raw) || /[<>]/.test(raw)) {
    throw new Error(`unescaped character in ${where}: ${JSON.stringify(raw)}`);
  }
  return raw.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, name: string) => ENTITIES[name]!,
  );
}

/**
 * Strict scanner for the renderer output: only the tags and attributes the
 * renderer emits, properly nested, with every "<", ">" and "&" of the content
 * escaped. Returns the decoded text with the formatting around each char.
 */
function scanHtml(html: string): Scan {
  const scan: Scan = {
    chars: [],
    hrefs: [],
    blockIds: [],
    amendmentIds: [],
    breaks: 0,
  };
  const stack: { tag: string; href?: string; label?: boolean }[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      const text = decodeEntities(html.slice(i, end), "text");
      const formats = [
        ...new Set(
          stack.flatMap((frame) => {
            if (frame.tag === "a") return [`link:${frame.href}`];
            const format = FORMAT_TAGS[frame.tag];
            return format ? [format] : [];
          }),
        ),
      ].sort();
      const removed = stack.some((frame) => frame.tag === "del");
      const label = stack.some((frame) => frame.tag === "sup" || frame.label);
      for (let k = 0; k < text.length; k += 1) {
        scan.chars.push({ char: text[k]!, formats, removed, label });
      }
      i = end;
      continue;
    }

    TAG.lastIndex = i;
    const match = TAG.exec(html);
    if (!match) {
      throw new Error(`unescaped "<" at ${i}: ${html.slice(i, i + 60)}`);
    }
    const closing = match[1] === "/";
    const tag = match[2] ?? "";
    if (!ALLOWED_TAGS.has(tag)) throw new Error(`unexpected tag <${tag}>`);
    const attributes = new Map<string, string>();
    for (const [, name = "", value = ""] of (match[3] ?? "").matchAll(
      ATTRIBUTE,
    )) {
      if (!ALLOWED_ATTRIBUTES.has(name)) {
        throw new Error(`unexpected attribute ${name} on <${tag}>`);
      }
      attributes.set(name, decodeEntities(value, `attribute ${name}`));
    }
    i += match[0].length;

    if (closing) {
      if (attributes.size > 0) throw new Error(`attributes on </${tag}>`);
      const open = stack.pop();
      if (open?.tag !== tag) {
        throw new Error(`</${tag}> closes <${open?.tag ?? "nothing"}>`);
      }
      continue;
    }
    if (tag === "br") {
      scan.breaks += 1;
      continue;
    }
    const href = attributes.get("href");
    if ((tag === "a") !== (href !== undefined)) {
      throw new Error(`href on <${tag}>, or <a> without href`);
    }
    if (href !== undefined) scan.hrefs.push(href);
    const blockId = attributes.get("data-block-id");
    if (blockId !== undefined) scan.blockIds.push(blockId);
    const amendmentId = attributes.get("data-amendment-id");
    if (amendmentId !== undefined) scan.amendmentIds.push(amendmentId);
    // Words the diff adds: the hidden ones and the label of a format change.
    const classes = (attributes.get("class") ?? "").split(" ");
    stack.push({
      tag,
      href,
      label: classes.includes("sr-only") || classes.includes("cx-fmt-label"),
    });
  }
  if (stack.length > 0) {
    throw new Error(`unclosed ${stack.map((frame) => `<${frame.tag}>`)}`);
  }
  return scan;
}

/** A link is safe when its scheme is http, https or mailto. */
function isAllowedScheme(href: string | undefined): href is string {
  return href !== undefined && /^(https?:|mailto:)/i.test(href.trim());
}

function assertSafeHrefs(hrefs: string[]): void {
  for (const href of hrefs) {
    // What a browser resolves: tabs and newlines removed, controls trimmed.
    const resolved = href
      .replace(/[\t\n\r]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "")
      .toLowerCase();
    if (!/^(https?:|mailto:)/.test(resolved)) {
      throw new Error(`unsafe href ${JSON.stringify(href)}`);
    }
  }
}

/** Visible characters of `blocks` (hard breaks excluded) and their formats. */
function expectedChars(blocks: Pick<Block, "text" | "marks">[]) {
  const chars: { char: string; formats: string[] }[] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.text.length; i += 1) {
      if (block.text[i] === "\n") continue;
      const formats = new Set<string>();
      for (const mark of block.marks) {
        if (mark.from > i || mark.to <= i) continue;
        if (mark.type !== "link") formats.add(mark.type);
        else if (isAllowedScheme(mark.href)) {
          formats.add(`link:${mark.href.trim()}`);
        }
      }
      chars.push({ char: block.text[i]!, formats: [...formats].sort() });
    }
  }
  return chars;
}

// ---------------------------------------------------------------------------
// Editor checks

function editorDocument(rng: Rng, wellFormed: boolean): Block[] {
  const blocks: Block[] = [];
  for (let n = rng.int(1, 10); n > 0; n -= 1) {
    const id = `blk${blocks.length}`;
    const text = randomText(rng);
    const marks = randomMarks(rng, text, {
      hrefs: HOSTILE_HREFS,
      maxMarks: 4,
    });
    const roll = rng.next();
    if (roll < 0.4) {
      const previous = blocks[blocks.length - 1];
      const deepest = !wellFormed
        ? 4
        : previous?.type === "list_item"
          ? (previous.level ?? 0) + 1
          : 0;
      blocks.push({
        id,
        type: "list_item",
        level: rng.int(0, deepest),
        list: rng.pick(LIST_STYLES),
        text,
        marks,
      });
    } else if (roll < 0.55) {
      blocks.push({ id, type: "heading", level: rng.int(1, 4), text, marks });
    } else if (roll < 0.75) {
      blocks.push({ id, type: "quote", text, marks });
    } else {
      blocks.push({ id, type: "paragraph", text, marks });
    }
  }
  return blocks;
}

/** List runs start at depth 0 and go at most one level deeper per item. */
function hasWellFormedLists(blocks: Block[]): boolean {
  return blocks.every((block, i) => {
    if (block.type !== "list_item") return true;
    const previous = blocks[i - 1];
    const deepest =
      previous?.type === "list_item" ? (previous.level ?? 0) + 1 : 0;
    return (block.level ?? 0) <= deepest;
  });
}

function editorRoundTrip(blocks: Block[]): Block[] {
  return editorToBlocks(blocksToEditor(blocks), () => {
    throw new Error("editorToBlocks asked for a fresh id");
  });
}

function blockShape(block: Block) {
  return {
    id: block.id,
    type: block.type,
    level: block.level,
    list: block.list,
    text: block.text,
  };
}

/**
 * Formatting of every character, as sorted mark keys. Hard breaks carry no
 * marks in the editor, so newline characters have none, and a link counts
 * only with an address the schema keeps (trimmed): the editor reads no other.
 */
function formatsByChar(block: Pick<Block, "text" | "marks">): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < block.text.length; i += 1) {
    if (block.text[i] === "\n") {
      result.push([]);
      continue;
    }
    const keys = block.marks
      .filter((mark) => mark.from <= i && i < mark.to)
      .filter((mark) => mark.type !== "link" || isAllowedScheme(mark.href))
      .map((mark) =>
        mark.type === "link" ? `link:${mark.href?.trim()}` : mark.type,
      );
    result.push([...new Set(keys)].sort());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Properties

describe("amendment engine properties", () => {
  it("1. diffPassage and consolidate reproduce any edited passage", () => {
    const coverage = new Coverage();
    forAll(400, 1_000_000, (rng, ctx) => {
      const base = randomDocument(rng, 1, 8);
      const start = rng.int(0, base.length - 1);
      const end = rng.int(start + 1, base.length);
      const passage = base.slice(start, end);
      const edited = editPassage(rng, passage, idSequence("new"));
      const movedIds = new Set<string>();
      const newId = () => {
        const id = `moved${movedIds.size}`;
        movedIds.add(id);
        return id;
      };
      const anchorBefore = start > 0 ? base[start - 1]!.id : null;
      const ops = diffPassage(passage, edited, anchorBefore, newId);
      Object.assign(ctx, { base, start, end, edited, ops });
      const replaces = ops.filter(isReplace);
      coverage.hit(
        "format of a block",
        replaces.some((op) => op.block !== undefined),
      );
      coverage.hit(
        "marks of kept text",
        replaces.some(
          (op) => op.marks !== undefined && op.text === op.baseText,
        ),
      );
      coverage.hit(
        "new text with its own marks",
        replaces.some(
          (op) => op.marks !== undefined && op.text !== op.baseText,
        ),
      );
      coverage.hit(
        "text alone",
        replaces.some((op) => op.marks === undefined && op.block === undefined),
      );
      // A format the passage takes in the editor by itself (a nested item
      // alone comes back at the first level) is not the author's change.
      const untouched = new Map(
        editorRoundTrip(passage).map((block) => [block.id, block]),
      );
      const formatOf = (block: Block) => {
        const original = passage.find((item) => item.id === block.id);
        const echo = untouched.get(block.id);
        const next = blockFormatOf(block);
        return original &&
          echo &&
          next &&
          sameBlockFormat(blockFormatOf(echo)!, next)
          ? blockFormatOf(original)
          : next;
      };
      coverage.hit(
        "replace",
        ops.some((op) => op.op === "replace"),
      );
      coverage.hit(
        "insert",
        ops.some((op) => op.op === "insert"),
      );
      coverage.hit(
        "delete",
        ops.some((op) => op.op === "delete"),
      );
      coverage.hit(
        "insert at start",
        ops.some((op) => op.op === "insert" && op.afterBlockId === null),
      );
      coverage.hit("moved or repeated block", movedIds.size > 0);
      coverage.hit(
        "replace, insert and delete",
        ["replace", "insert", "delete"].every((kind) =>
          ops.some((op) => op.op === kind),
        ),
      );

      // A passage block keeps its id unless the operations delete it; the
      // first copy of a kept block is the kept one.
      const baseIds = new Set(base.map((block) => block.id));
      const deleted = new Set(
        ops.flatMap((op) => (op.op === "delete" ? op.blockIds : [])),
      );
      const keptIds = new Set(
        passage.map((block) => block.id).filter((id) => !deleted.has(id)),
      );
      const seen = new Set<string>();
      const expected = edited.flatMap((block) => {
        const kept = keptIds.has(block.id) && !seen.has(block.id);
        if (kept) seen.add(block.id);
        // diffPassage drops new blocks without visible text on purpose.
        if (!kept && block.text.trim() === "") return [];
        return [
          passageView(
            block,
            kept,
            (id) => baseIds.has(id),
            kept ? formatOf(block) : null,
          ),
        ];
      });

      if (ops.length === 0) {
        expect(expected).toEqual(
          passage.map((block) => passageView(block, true, () => false)),
        );
        return;
      }
      expect(validateOps(base, ops)).toEqual([]);
      const result = consolidate(base, [{ id: "A", ops }]);
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toEqual(["A"]);

      const after = base.length - end;
      expect(result.blocks.slice(0, start)).toEqual(base.slice(0, start));
      expect(result.blocks.slice(result.blocks.length - after)).toEqual(
        base.slice(end),
      );
      const middle = result.blocks.slice(start, result.blocks.length - after);
      expect(
        middle.map((block) =>
          passageView(block, baseIds.has(block.id), (id) => movedIds.has(id)),
        ),
      ).toEqual(expected);
      expect(new Set(result.blocks.map((block) => block.id)).size).toBe(
        result.blocks.length,
      );
      assertWellFormed(result);
    });
    coverage.expectAtLeast({
      replace: 100,
      insert: 80,
      delete: 50,
      "insert at start": 5,
      "moved or repeated block": 30,
      "replace, insert and delete": 12,
      "format of a block": 40,
      "marks of kept text": 60,
      "new text with its own marks": 30,
      "text alone": 60,
    });
  });

  it("1b. new text keeps the format the editor shows, however the base stores its marks", () => {
    const coverage = new Coverage();
    forAll(600, 1_500_000, (rng, ctx) => {
      // Marks as an import may store them: same type in adjacent or
      // overlapping pieces. The editor gives one mark per run.
      const text = phrase(rng, 2, 8);
      const base: Block = {
        id: "blk0",
        type: "paragraph",
        text,
        marks: randomMarks(rng, text, { maxMarks: 6 }),
      };
      const echo = editorRoundTrip([base])[0]!;
      // Typed in the editor: new text takes the format of the character
      // before it.
      const offsets = codePointOffsets(text);
      const from = rng.pick(offsets);
      const to = rng.chance(0.5)
        ? from
        : rng.pick(offsets.filter((offset) => offset >= from));
      const typed = `${rng.pick(WORDS)} `;
      const shown = markCoverage(echo.marks, text.length);
      const inherits = from > 0 && text[from - 1] !== "\n";
      const want = shown.map((row) => [
        ...row.slice(0, from),
        ...new Array<string | null>(typed.length).fill(
          inherits ? row[from - 1]! : null,
        ),
        ...row.slice(to),
      ]);
      const edited: Block = {
        ...echo,
        text: text.slice(0, from) + typed + text.slice(to),
        marks: coverageToMarks(want),
      };
      const ops = diffPassage([base], [edited], null, () => "fresh");
      Object.assign(ctx, { base, edited, ops });
      coverage.hit(
        "new text with its own marks",
        ops.some(
          (op) =>
            op.op === "replace" &&
            op.marks !== undefined &&
            op.text !== op.baseText,
        ),
      );
      expect(validateOps([base], ops)).toEqual([]);
      const result = consolidate([base], [{ id: "A", ops }]).blocks[0]!;
      expect(result.text).toBe(edited.text);
      expect(formatsByChar(result)).toEqual(formatsByChar(edited));
    });
    coverage.expectAtLeast({ "new text with its own marks": 10 });
  });

  it("2. amendments without hard overlaps consolidate alike in any order", () => {
    const coverage = new Coverage();
    forAll(300, 2_000_000, (rng, ctx) => {
      const base = randomDocument(rng, 2, 5, { maxWords: 5 });
      const candidates = randomAmendments(rng, base, rng.int(2, 7), {
        maxWords: 3,
      });
      const amendments: AmendmentInput[] = [];
      for (const candidate of candidates) {
        const clash = amendments.some((other) =>
          isHardOverlap(overlapBetween(other.ops, candidate.ops)),
        );
        if (!clash) amendments.push(candidate);
      }
      Object.assign(ctx, { base, amendments });
      coverage.hit("2+ amendments", amendments.length >= 2);
      coverage.hit("4+ amendments", amendments.length >= 4);
      coverage.hit(
        "dropped a hard overlap",
        amendments.length < candidates.length,
      );
      coverage.hit("2+ edit one block", sharesKey(amendments, blockKeys));
      coverage.hit(
        "2+ insert at one anchor",
        sharesKey(amendments, anchorKeys),
      );

      expect(
        findOverlaps(amendments).pairs.filter((pair) =>
          isHardOverlap(pair.kind),
        ),
      ).toEqual([]);
      const reference = consolidate(base, amendments);
      expect(reference.conflicts).toEqual([]);
      expect(reference.applied).toEqual(amendments.map((a) => a.id));
      assertWellFormed(reference);
      const expected = canonicalOrder(reference.annotated);

      const orders = [
        [...amendments].reverse(),
        rng.shuffle(amendments),
        rng.shuffle(amendments),
        rng.shuffle(amendments),
      ];
      for (const order of orders) {
        ctx.order = order.map((amendment) => amendment.id);
        const result = consolidate(base, order);
        expect(result.conflicts).toEqual([]);
        expect(canonicalOrder(result.annotated)).toEqual(expected);
        assertWellFormed(result);
      }
    });
    coverage.expectAtLeast({
      "2+ amendments": 150,
      "4+ amendments": 25,
      "dropped a hard overlap": 100,
      "2+ edit one block": 30,
      "2+ insert at one anchor": 20,
    });
  });

  it("3. overlaps are symmetric and clusters partition the overlapping ids", () => {
    const coverage = new Coverage();
    forAll(400, 3_000_000, (rng, ctx) => {
      const base = randomDocument(rng, 2, 5, { maxWords: 5 });
      const amendments = randomAmendments(rng, base, rng.int(2, 7), {
        maxWords: 3,
      });
      Object.assign(ctx, { base, amendments });

      const expected: { a: string; b: string; kind: OverlapKind }[] = [];
      amendments.forEach((a, i) => {
        for (const b of amendments.slice(i + 1)) {
          const kind = overlapBetween(a.ops, b.ops);
          expect(overlapBetween(b.ops, a.ops), `${a.id} / ${b.id}`).toBe(kind);
          if (kind) expected.push({ a: a.id, b: b.id, kind });
        }
      });

      const report = findOverlaps(amendments);
      expect(pairTable(report.pairs)).toEqual(pairTable(expected));
      assertClusters(report);

      const permuted = findOverlaps(rng.shuffle(amendments));
      expect(pairTable(permuted.pairs)).toEqual(pairTable(expected));
      expect(canonicalClusters(permuted)).toEqual(canonicalClusters(report));

      coverage.hit("no overlap", report.pairs.length === 0);
      for (const kind of new Set(report.pairs.map((pair) => pair.kind))) {
        coverage.hit(kind);
      }
      coverage.hit("2+ clusters", report.clusters.length >= 2);
      coverage.hit(
        "cluster of 3+",
        report.clusters.some((c) => c.length >= 3),
      );
      coverage.hit(
        "cluster linked through a third",
        report.clusters.some((cluster) =>
          cluster.some((a, i) =>
            cluster
              .slice(i + 1)
              .some(
                (b) =>
                  !report.pairs.some(
                    (p) => pairKey(p.a, p.b) === pairKey(a, b),
                  ),
              ),
          ),
        ),
      );
    });
    coverage.expectAtLeast({
      "no overlap": 25,
      same_text: 80,
      removed_block: 80,
      same_position: 50,
      "2+ clusters": 20,
      "cluster of 3+": 80,
      "cluster linked through a third": 70,
    });
  });

  it("4. consolidated marks stay in bounds and untouched marks keep their text", () => {
    type TaggedMark = Mark & { key: string };
    const coverage = new Coverage();
    forAll(300, 4_000_000, (rng, ctx) => {
      const base = randomDocument(rng, 2, 6, { maxMarks: 4 }).map((block) => ({
        ...block,
        marks: block.marks.map((mark, k): TaggedMark => ({
          ...mark,
          key: `${block.id}#${k}`,
        })),
      }));
      // Operations of text alone, as stored before formatting could be
      // amended: their marks follow the text exactly as they always did.
      const amendments = randomAmendments(rng, base, rng.int(1, 6))
        .map((amendment) => ({ ...amendment, ops: textOnly(amendment.ops) }))
        .filter((amendment) => amendment.ops.length > 0);
      Object.assign(ctx, { base, amendments });
      for (const amendment of amendments) {
        expect(validateOps(base, amendment.ops)).toEqual([]);
      }

      const result = consolidate(base, amendments);
      assertWellFormed(result);

      const applied = amendments.filter((a) => result.applied.includes(a.id));
      const replaces = applied.flatMap((a) => a.ops).filter(isReplace);
      for (const block of result.blocks) {
        const original = base.find((candidate) => candidate.id === block.id);
        if (!original) continue;
        const ops = replaces
          .filter((op) => op.blockId === block.id)
          .sort(compareReplaceOps);
        expect(block.type).toBe(original.type);
        expect(block.marks).toEqual(
          original.marks
            .map((mark) => ({
              ...mark,
              from: mapPosition(mark.from, ops, 1),
              to: mapPosition(mark.to, ops, -1),
            }))
            .filter((mark) => mark.from < mark.to),
        );
        for (const mark of original.marks as TaggedMark[]) {
          const untouched = ops.every(
            (op) => op.to <= mark.from || op.from >= mark.to,
          );
          coverage.hit("edited inside a mark", !untouched);
          if (!untouched) continue;
          const mapped = (block.marks as TaggedMark[]).find(
            (candidate) => candidate.key === mark.key,
          );
          expect(mapped, `mark ${mark.key} was dropped`).toBeDefined();
          expect(block.text.slice(mapped!.from, mapped!.to)).toBe(
            original.text.slice(mark.from, mark.to),
          );
          coverage.hit("shifted mark", mapped!.from !== mark.from);
          coverage.hit(
            "insertion at a mark edge",
            ops.some(
              (op) =>
                op.from === op.to &&
                (op.from === mark.from || op.from === mark.to),
            ),
          );
        }
      }
    });
    coverage.expectAtLeast({
      "edited inside a mark": 150,
      "shifted mark": 80,
      "insertion at a mark edge": 25,
    });
  });

  it("5. rendering escapes all text and only links safe schemes", () => {
    const hostile: ContentOptions = {
      words: HOSTILE_WORDS,
      hrefs: HOSTILE_HREFS,
      maxMarks: 4,
    };
    const formatLabels = new Coverage();
    forAll(250, 5_000_000, (rng, ctx) => {
      const blocks = randomDocument(rng, 1, 8, hostile).map((block, i) => ({
        ...block,
        id: rng.chance(0.3) ? `${rng.pick(HOSTILE_IDS)}${i}` : block.id,
        // Marks past the end of the text must be clamped, not trusted.
        marks: rng.chance(0.1)
          ? [
              ...block.marks,
              {
                type: "italic" as const,
                from: 0,
                to: block.text.length + 3,
              },
            ]
          : block.marks,
      }));
      ctx.blocks = blocks;
      const html = renderBlocks(blocks);
      ctx.html = html;
      const scan = scanHtml(html);
      expect(scan.blockIds).toEqual(blocks.map((block) => block.id));
      expect(
        scan.chars.map(({ char, formats }) => ({ char, formats })),
      ).toEqual(expectedChars(blocks));
      expect(scan.breaks).toBe(
        blocks.reduce(
          (count, block) =>
            count + (block.text === "" ? 1 : block.text.split("\n").length - 1),
          0,
        ),
      );
      assertSafeHrefs(scan.hrefs);

      const base = randomDocument(rng, 2, 5, hostile);
      const amendments = randomAmendments(
        rng,
        base,
        rng.int(1, 5),
        hostile,
        idSequence('ins"<&'),
        (index) =>
          rng.chance(0.4) ? `${rng.pick(HOSTILE_IDS)}${index}` : `am${index}`,
      );
      const result = consolidate(base, amendments);
      const ids = new Set(amendments.map((amendment) => amendment.id));
      Object.assign(ctx, { base, amendments });

      for (const mode of ["diff", "clean", "provenance"] as const) {
        const focus =
          amendments.length > 0 && rng.chance(0.5)
            ? rng.pick(amendments).id
            : null;
        const annotatedHtml = renderAnnotated(result.annotated, {
          mode,
          focus,
          label: (id) => `<${id}>&"'`,
          diffLabels: {
            inserted: "<added>&",
            removed: '"removed">',
            formatted: "<format>&",
            format: (change) => `<${change.code}>&"${change.value ?? ""}'`,
          },
        });
        if (mode === "diff") {
          const formatted = result.annotated.some(
            (block) =>
              block.status === "kept" &&
              (block.format !== undefined ||
                block.segments.some((segment) => segment.format)),
          );
          formatLabels.hit("format label", formatted);
          expect(annotatedHtml.includes("cx-fmt-label")).toBe(formatted);
        }
        Object.assign(ctx, { mode, html: annotatedHtml });
        const annotatedScan = scanHtml(annotatedHtml);
        const visible = result.annotated.filter(
          (block) => mode === "diff" || block.status !== "deleted",
        );
        expect(annotatedScan.blockIds).toEqual(
          visible.map((block) => block.id),
        );
        for (const id of annotatedScan.amendmentIds) {
          expect(ids.has(id), `unknown amendment ${id}`).toBe(true);
        }
        assertSafeHrefs(annotatedScan.hrefs);

        const shown = annotatedScan.chars.filter(
          (char) => !char.removed && !char.label,
        );
        expect(shown.map(({ char, formats }) => ({ char, formats }))).toEqual(
          expectedChars(result.blocks),
        );
        const removed = annotatedScan.chars.filter(
          (char) => char.removed && !char.label,
        );
        if (mode !== "diff") {
          expect(removed).toEqual([]);
          continue;
        }
        expect(removed.every((char) => char.formats.length === 0)).toBe(true);
        expect(removed.map((char) => char.char).join("")).toBe(
          visible
            .flatMap((block) => block.segments)
            .filter((segment) => segment.removed)
            .map((segment) => segment.text)
            .join("")
            .replace(/\n/g, ""),
        );
      }
    });
    formatLabels.expectAtLeast({ "format label": 60 });
  });

  it("6. well-formed blocks round-trip through the editor JSON", () => {
    forAll(500, 6_000_000, (rng, ctx) => {
      const blocks = editorDocument(rng, true);
      ctx.blocks = blocks;
      const back = editorRoundTrip(blocks);
      ctx.back = back;
      expect(back.map(blockShape)).toEqual(blocks.map(blockShape));
      expect(back.map(formatsByChar)).toEqual(blocks.map(formatsByChar));
    });
  });

  it("6b. any block list reaches an editor fixed point after one round trip", () => {
    forAll(300, 7_000_000, (rng, ctx) => {
      const blocks = editorDocument(rng, false);
      ctx.blocks = blocks;
      const once = editorRoundTrip(blocks);
      ctx.once = once;
      // Only list depth may change: a list cannot start below depth 0 or
      // skip a level, so such items are lifted.
      const withoutDepth = (block: Block) => ({
        ...blockShape(block),
        level: block.type === "list_item" ? null : block.level,
      });
      expect(once.map(withoutDepth)).toEqual(blocks.map(withoutDepth));
      expect(once.map(formatsByChar)).toEqual(blocks.map(formatsByChar));
      once.forEach((block, i) => {
        if (block.type !== "list_item") return;
        expect(block.level ?? 0).toBeLessThanOrEqual(blocks[i]!.level ?? 0);
      });
      expect(hasWellFormedLists(once)).toBe(true);
      expect(editorRoundTrip(once)).toEqual(once);
    });
  });
});

// ---------------------------------------------------------------------------
// Defects the properties found, as minimal reproductions.

describe("engine regressions", () => {
  const base: Block[] = [
    { id: "base0", type: "paragraph", text: "uno dos tres", marks: [] },
  ];
  const replaceDos: AmendmentInput = {
    id: "A",
    ops: [
      {
        op: "replace",
        blockId: "base0",
        from: 4,
        to: 7,
        text: "DOS",
        baseText: "dos",
      },
    ],
  };
  const insertBeforeDos: AmendmentInput = {
    id: "B",
    ops: [
      {
        op: "replace",
        blockId: "base0",
        from: 4,
        to: 4,
        text: "cinco ",
        baseText: "",
      },
    ],
  };

  // Found by property 2. overlapBetween treats a point insertion at the first
  // offset of another amendment's replaced range as compatible. consolidate
  // used to sort replaces by `from` alone, so with the range first the
  // replaced base text was emitted twice ("uno DOScinco dos tres").
  // compareReplaceOps now puts the point first at the same offset.
  it("consolidates a point insertion at the start of another amendment's range in any order", () => {
    if (isHardOverlap(overlapBetween(replaceDos.ops, insertBeforeDos.ops))) {
      return;
    }
    const forward = consolidate(base, [replaceDos, insertBeforeDos]);
    const backward = consolidate(base, [insertBeforeDos, replaceDos]);
    expect(backward.blocks[0]!.text).toBe("uno cinco DOS tres");
    expect(forward.blocks[0]!.text).toBe(backward.blocks[0]!.text);
  });

  // Same tie inside one amendment: validateOps used to reject the two
  // operations as overlapping in one order and accept them in the other.
  it("validates the same operations alike in any order", () => {
    const ops = [...replaceDos.ops, ...insertBeforeDos.ops];
    const reasons = (list: AmendmentOp[]) =>
      validateOps(base, list).map((error) => error.reason);
    expect(reasons(ops)).toEqual(reasons([...ops].reverse()));
  });

  // diffPassage only knows the passage, so it keeps any id it does not
  // recognise as the caller's fresh id. That is a contract on callers: load
  // the editor with exactly the passage (the editor never reads ids from
  // pasted HTML). A caller that breaks it gets a `duplicate_block_id`
  // rejection, never a silently corrupted amendment.
  it("rejects an edited block that reuses the id of a base block outside the passage", () => {
    const document: Block[] = [
      { id: "base0", type: "paragraph", text: "uno", marks: [] },
      { id: "base1", type: "paragraph", text: "dos", marks: [] },
    ];
    const ops = diffPassage(
      [document[1]!],
      [document[1]!, { ...document[0]! }],
      "base0",
      idSequence("fresh"),
    );
    expect(validateOps(document, ops).map((e) => e.reason)).toContain(
      "duplicate_block_id",
    );
  });
});

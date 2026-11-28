import type { Block } from "../../types/content";

/**
 * The signing closing a text writes itself: «Para que conste a los efectos
 * oportunos…» or «Y por tanto firmo…», then the signer's name, office, place
 * and date. A document signed in the platform (actas, budgets, reports) gets
 * its closing and signature when the PDF to sign is prepared (user's
 * decisions of 2026-11-28), so a Word file imported into one drops its own
 * (DocxImport). Pure, no Vue.
 */

/**
 * The formulas a written closing opens with, on the text as normalised
 * (`normalize`): «Para que conste», «Y para que conste», «Y para que así
 * conste», «Y por tanto firmo», «Firmado» and «Fdo.».
 */
const CLOSING_FORMULA =
  /^(?:(?:y )?para que (?:asi )?conste|y por tanto firmo|firmado|fdo)\b/;

/** How far from its end a text is read for a closing: non-blank blocks. */
const CLOSING_TAIL = 12;
/** What may follow the formula: a name, an office, a place and date. */
const MAX_AFTER_BLOCKS = 5;
const MAX_AFTER_LENGTH = 200;

/** Lower case, without accents, punctuation as single spaces. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether a paragraph's text opens with a signing formula. */
/**
 * Where a text ends and its annexes begin, the signature going between
 * them: its first annex heading (Block.annex), or a heading of the text
 * itself that opens with «Anexo» (one written before annexes were marked,
 * 2026-11-26); its length when it has none.
 */
export function annexStart(blocks: readonly Block[]): number {
  const at = blocks.findIndex(
    (block) =>
      !block.cell &&
      (block.annex === true ||
        (block.type === "heading" && /^\s*anexo\b/i.test(block.text))),
  );
  return at < 0 ? blocks.length : at;
}

export function isClosingFormula(text: string): boolean {
  return CLOSING_FORMULA.test(normalize(text));
}

/** A blank line kept from Word: an empty paragraph outside any table. */
function isBlank(block: Block): boolean {
  return block.type === "paragraph" && !block.cell && block.text.trim() === "";
}

/** A paragraph of the text itself, outside any table. */
function isPlainParagraph(block: Block): boolean {
  return block.type === "paragraph" && !block.cell;
}

/** What may follow the formula: short paragraphs, never a heading, a list item, an image or a table. */
function isShortTail(blocks: readonly Block[]): boolean {
  const lines = blocks.filter((block) => !isBlank(block));
  return (
    lines.length <= MAX_AFTER_BLOCKS &&
    lines.every(
      (block) =>
        isPlainParagraph(block) && block.text.length <= MAX_AFTER_LENGTH,
    )
  );
}

/** Where a text's written closing sits: blocks [from, to). */
export interface WrittenClosing {
  from: number;
  to: number;
}

/**
 * The written signing closing of a text, if any. The text ends before its
 * first annex (an acta's annexes come after its signature); among the last
 * CLOSING_TAIL non-blank blocks of that part, the last paragraph opening
 * with a formula (isClosingFormula) starts it, and it runs to the end of the
 * part, blank lines included. It only counts if what follows the formula is
 * short (isShortTail), and if some text comes before it. An earlier formula
 * paragraph whose own tail is still short starts it instead («Y para que así
 * conste…», the place and date, «Fdo.: …»), so a closing is never cut in
 * half.
 */
export function findWrittenClosing(
  blocks: readonly Block[],
): WrittenClosing | null {
  const end = annexStart(blocks);
  const tail = blocks
    .slice(0, end)
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !isBlank(block))
    .slice(-CLOSING_TAIL);
  const formulas = tail
    .filter(
      ({ block }) => isPlainParagraph(block) && isClosingFormula(block.text),
    )
    .map(({ index }) => index);
  const last = formulas.at(-1);
  if (last === undefined || !isShortTail(blocks.slice(last + 1, end)))
    return null;
  let from = last;
  for (const index of formulas.slice(0, -1).reverse()) {
    if (!isShortTail(blocks.slice(index + 1, end))) break;
    from = index;
  }
  // A text that is only its closing keeps it: nothing would be left.
  if (!blocks.slice(0, from).some((block) => !isBlank(block))) return null;
  return { from, to: end };
}

/**
 * The text without its written closing (findWrittenClosing), and how many
 * blocks went: the closing's, and the blank lines left just before it.
 */
export function withoutWrittenClosing(blocks: readonly Block[]): {
  blocks: Block[];
  removed: number;
} {
  const closing = findWrittenClosing(blocks);
  if (!closing) return { blocks: [...blocks], removed: 0 };
  let from = closing.from;
  while (from > 0 && isBlank(blocks[from - 1]!)) from--;
  return {
    blocks: [...blocks.slice(0, from), ...blocks.slice(closing.to)],
    removed: closing.to - from,
  };
}

/**
 * Justified lines that open space only between words.
 *
 * pdfmake justifies a line by spreading its free width evenly over every
 * gap between its inlines (ElementWriter.alignLine). An inline is a word,
 * but also a piece of one wherever the word changes font or style: a letter
 * in Raleway's latin-ext cut (pdfSerial.ts, «Gda|ń|sk»), or a bold or
 * italic prefix. pdfmake keeps those pieces on one line (TextBreaker marks
 * every piece but the last `noNewLine`), yet stock justification opened a
 * gap inside the word. installWordJustify replaces it so the space goes
 * only after an inline that ends a word.
 *
 * Both functions travel to the render process as source (pdfRender.ts embeds
 * them with toString), so each is self-contained: no imports, no names from
 * this module, no named inner functions.
 */

/** What wordJustifyShifts reads of a laid-out inline. */
export interface JustifiedInline {
  /** Set by pdfmake on a piece the next inline continues (same word). */
  noNewLine?: boolean;
}

/** How each inline of a justified line moves (wordJustifyShifts). */
export interface JustifyShifts {
  /** Added to each inline's x. */
  offsets: number[];
  /** The space opened just before each inline (pdfmake's justifyShift). */
  gaps: number[];
}

/**
 * The shifts that justify a line `free` points short of its width: the
 * space goes in equal parts to the gaps between words, the places after an
 * inline that does not carry `noNewLine`. Null when there is nothing to
 * spread or no gap between words (a line that is one word in pieces): the
 * line then stays as laid out.
 */
export function wordJustifyShifts(
  inlines: readonly JustifiedInline[],
  free: number,
): JustifyShifts | null {
  if (!(free > 0) || inlines.length < 2) return null;
  let wordGaps = 0;
  for (let index = 1; index < inlines.length; index += 1) {
    if (!inlines[index - 1]!.noNewLine) wordGaps += 1;
  }
  if (wordGaps === 0) return null;
  const share = free / wordGaps;
  const offsets = [0];
  const gaps = [0];
  let offset = 0;
  for (let index = 1; index < inlines.length; index += 1) {
    const gap = inlines[index - 1]!.noNewLine ? 0 : share;
    offset += gap;
    offsets.push(offset);
    gaps.push(gap);
  }
  return { offsets, gaps };
}

/** The part of pdfmake's laid-out line installWordJustify works with. */
interface LaidOutLine {
  inlines?: (JustifiedInline & {
    alignment?: string;
    x: number;
    justifyShift?: number;
  })[];
  newLineForced?: boolean;
  lastLineInParagraph?: boolean;
  getWidth(): number;
}

interface ElementWriterLike {
  context(): { availableWidth: number };
  alignLine(line: LaidOutLine): void;
}

/**
 * Makes pdfmake's ElementWriter (its class, from `pdfmake/js/ElementWriter`)
 * justify with `shifts` (wordJustifyShifts), keeping its own alignment for
 * every line that is not justified. False when the class is not the one
 * expected: pdfmake then justifies as it always did. Idempotent.
 */
export function installWordJustify(
  writer: unknown,
  shifts: (
    inlines: readonly JustifiedInline[],
    free: number,
  ) => JustifyShifts | null,
): boolean {
  const proto =
    typeof writer === "function"
      ? (writer.prototype as Partial<ElementWriterLike> & {
          wordJustify?: boolean;
        })
      : null;
  if (!proto || typeof proto.alignLine !== "function") return false;
  if (proto.wordJustify) return true;
  const stock = proto.alignLine;
  proto.alignLine = function (this: ElementWriterLike, line: LaidOutLine) {
    const inlines = line.inlines;
    if (
      !inlines ||
      inlines.length < 2 ||
      inlines[0]!.alignment !== "justify" ||
      line.newLineForced ||
      line.lastLineInParagraph
    ) {
      stock.call(this, line);
      return;
    }
    const spread = shifts(
      inlines,
      this.context().availableWidth - line.getWidth(),
    );
    if (!spread) return;
    for (let index = 1; index < inlines.length; index += 1) {
      inlines[index]!.x += spread.offsets[index]!;
      inlines[index]!.justifyShift = spread.gaps[index]!;
    }
  };
  proto.wordJustify = true;
  return true;
}

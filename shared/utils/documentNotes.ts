import type { DocumentNoteAnchor, DocumentNoteDto } from "../types/api";

/**
 * Private notes on a document (docs/design.md, "Private notes"): pure
 * rules shared by the server (limits) and the pages (where a note falls in
 * the text as it is now).
 */

/** Longest note. */
export const DOCUMENT_NOTE_MAX_LENGTH = 4000;
/** Longest stretch of text a note keeps as its quote. */
export const DOCUMENT_NOTE_QUOTE_MAX_LENGTH = 2000;
/** Most notes one account keeps on one document. */
export const DOCUMENT_NOTES_MAX = 200;

/**
 * Where an anchored note falls in its block's text as it is now: where it
 * was written if the text there is still the quote, else the first place
 * the quote shows in the block. Null when the block no longer holds it.
 */
export function locateNote(
  anchor: Pick<DocumentNoteAnchor, "from" | "to" | "quote">,
  blockText: string,
): { from: number; to: number } | null {
  const { from, to, quote } = anchor;
  if (!quote) return null;
  if (blockText.slice(from, to) === quote) return { from, to };
  const at = blockText.indexOf(quote);
  return at < 0 ? null : { from: at, to: at + quote.length };
}

export interface PlacedNotes<T> {
  /** About the whole document, oldest first. */
  general: T[];
  /** On the text, in the order of the text. */
  placed: T[];
  /** Whose stretch the text no longer holds, oldest first. */
  orphaned: T[];
}

/**
 * The notes sorted for a list: the general ones, the ones on the text in
 * its order, and the ones the text no longer holds. `blocks` is the text as
 * published now.
 */
export function placeNotes<
  T extends Pick<DocumentNoteDto, "anchor" | "createdAt">,
>(
  notes: readonly T[],
  blocks: readonly { id: string; text: string }[],
): PlacedNotes<T> {
  const order = new Map(blocks.map((block, index) => [block.id, index]));
  const text = new Map(blocks.map((block) => [block.id, block.text]));
  const byAge = (a: T, b: T) => a.createdAt.localeCompare(b.createdAt);
  const general: T[] = [];
  const orphaned: T[] = [];
  const placed: { note: T; block: number; from: number }[] = [];
  for (const note of notes) {
    if (!note.anchor) {
      general.push(note);
      continue;
    }
    const blockText = text.get(note.anchor.blockId);
    const at =
      blockText === undefined ? null : locateNote(note.anchor, blockText);
    if (!at) orphaned.push(note);
    else {
      placed.push({
        note,
        block: order.get(note.anchor.blockId)!,
        from: at.from,
      });
    }
  }
  return {
    general: general.sort(byAge),
    placed: placed
      .sort(
        (a, b) => a.block - b.block || a.from - b.from || byAge(a.note, b.note),
      )
      .map((entry) => entry.note),
    orphaned: orphaned.sort(byAge),
  };
}

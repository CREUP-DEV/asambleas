/**
 * Where the card of a note opens over the text (`DocumentNotes`): under the
 * passage, or above it when it does not fit under and there is more room
 * above, never past an edge of the window. Pure: the component feeds it the
 * passage's box and the window's size.
 */

/** Pixels. */
export const NOTE_CARD = {
  /** Its width where the window allows it. */
  width: 320,
  /** Kept from every edge of the window. */
  margin: 8,
  /** Between the passage and the card. */
  gap: 6,
  /**
   * About the tallest a card gets (its text scrolls past 12rem): with this
   * much room under the passage it opens there, otherwise on the side with
   * more room.
   */
  room: 256,
} as const;

export interface NoteCardBox {
  top: number;
  bottom: number;
  left: number;
}

export interface NoteCardPlace {
  left: number;
  width: number;
  /** From the window's top, when it opens under the passage. */
  top?: number;
  /** From the window's bottom, when it opens above: no height to measure. */
  bottom?: number;
  /** The room on its side, so a long note scrolls inside it. */
  maxHeight: number;
}

export function placeNoteCard(
  box: NoteCardBox,
  viewport: { width: number; height: number },
): NoteCardPlace {
  const { width: card, margin, gap, room } = NOTE_CARD;
  const width = Math.max(0, Math.min(card, viewport.width - 2 * margin));
  const left = Math.max(
    margin,
    Math.min(box.left, viewport.width - width - margin),
  );
  const below = viewport.height - box.bottom - gap - margin;
  const above = box.top - gap - margin;
  if (below >= room || below >= above) {
    return {
      left,
      width,
      top: box.bottom + gap,
      maxHeight: Math.max(0, below),
    };
  }
  return {
    left,
    width,
    bottom: viewport.height - box.top + gap,
    maxHeight: Math.max(0, above),
  };
}

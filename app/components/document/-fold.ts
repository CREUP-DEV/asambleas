/**
 * When the header of a document being read folds away (the document page,
 * on large screens, where the text scrolls inside its panel): going down
 * into the text folds it, starting to go back up unfolds it, and so does
 * the top of the text. Pure: the page feeds it each scroll of the text.
 */

/** Pixels, measured on the text panel's scroll. */
export const FOLD = {
  /** Never folded this close to the top. */
  at: 96,
  /** At the top (or this close) it is always unfolded. */
  top: 4,
  /** How far the reader goes one way before it folds or unfolds. */
  turn: 24,
  /**
   * Folding gives the panel more height, which shortens how far it can
   * scroll: a text that barely overflows never folds, so it cannot bounce
   * between the two.
   */
  minRoom: 320,
} as const;

export interface FoldState {
  folded: boolean;
  /**
   * Where the current run started: the lowest point while unfolded (going
   * down from it folds), the highest while folded (going up from it
   * unfolds).
   */
  anchor: number;
}

export const UNFOLDED: FoldState = { folded: false, anchor: 0 };

/**
 * The state after a scroll to `scrollTop`, in a text that can scroll
 * `room` pixels (scrollHeight minus clientHeight).
 */
export function foldOnScroll(
  state: FoldState,
  scrollTop: number,
  room: number,
): FoldState {
  if (scrollTop <= FOLD.top || room <= FOLD.minRoom) {
    return { folded: false, anchor: scrollTop };
  }
  if (state.folded) {
    if (state.anchor - scrollTop >= FOLD.turn) {
      return { folded: false, anchor: scrollTop };
    }
    return { folded: true, anchor: Math.max(state.anchor, scrollTop) };
  }
  if (scrollTop > FOLD.at && scrollTop - state.anchor >= FOLD.turn) {
    return { folded: true, anchor: scrollTop };
  }
  return { folded: false, anchor: Math.min(state.anchor, scrollTop) };
}

/**
 * While the fold animates the panel changes height, and at the end of the
 * text that moves its scroll by itself: those moves only reset the anchor,
 * so they never fold or unfold it back.
 */
export function settleFold(state: FoldState, scrollTop: number): FoldState {
  return { folded: state.folded, anchor: scrollTop };
}

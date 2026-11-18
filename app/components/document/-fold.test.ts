import { describe, expect, it } from "vitest";
import {
  FOLD,
  UNFOLDED,
  foldOnScroll,
  settleFold,
  type FoldState,
} from "./-fold";

const ROOM = 5000;

function run(scrolls: number[], start: FoldState = UNFOLDED, room = ROOM) {
  return scrolls.reduce((state, top) => foldOnScroll(state, top, room), start);
}

describe("foldOnScroll", () => {
  it("stays unfolded near the top", () => {
    expect(run([10, 40, FOLD.at]).folded).toBe(false);
  });

  it("folds going down into the text", () => {
    expect(run([50, 120, 200]).folded).toBe(true);
  });

  it("unfolds as soon as the reader goes back up a little", () => {
    const folded = run([200, 600, 900]);
    expect(folded.folded).toBe(true);
    expect(foldOnScroll(folded, 900 - FOLD.turn + 1, ROOM).folded).toBe(true);
    expect(foldOnScroll(folded, 900 - FOLD.turn, ROOM).folded).toBe(false);
  });

  it("folds again going down after unfolding mid-text", () => {
    const unfolded = run([200, 900, 850]);
    expect(unfolded.folded).toBe(false);
    expect(foldOnScroll(unfolded, 860, ROOM).folded).toBe(false);
    expect(foldOnScroll(unfolded, 850 + FOLD.turn, ROOM).folded).toBe(true);
  });

  it("always unfolds at the top", () => {
    expect(foldOnScroll(run([200, 900]), 0, ROOM).folded).toBe(false);
  });

  it("never folds a text that barely overflows", () => {
    expect(run([200, 300], UNFOLDED, FOLD.minRoom).folded).toBe(false);
  });
});

describe("settleFold", () => {
  it("lets the panel move the scroll without unfolding it", () => {
    const folded = run([200, 900]);
    // Folding grew the panel: at the end of the text its scroll went up.
    const settled = settleFold(folded, 780);
    expect(settled.folded).toBe(true);
    expect(foldOnScroll(settled, 770, ROOM).folded).toBe(true);
  });
});

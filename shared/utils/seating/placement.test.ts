import { describe, expect, it } from "vitest";
import { emptySeatingLayout, type SeatingLayout } from "./layout";
import { blockSeats } from "./placement";
import { seatingWalk } from "./runs";

/** One row of eight seats (r3 disabled) and two loose chairs. */
const layout: SeatingLayout = {
  ...emptySeatingLayout(),
  tables: [
    {
      id: "t1",
      shape: "rect",
      x: 0,
      y: 0,
      w: 480,
      h: 60,
      rotation: 0,
      zone: "delegates",
      run: "row",
      seats: Array.from({ length: 8 }, (_, index) => ({
        id: `r${index}`,
        side: "front" as const,
        index,
        ...(index === 3 ? { disabled: true } : {}),
      })),
    },
  ],
  chairs: [
    { id: "c0", x: 900, y: 0, rotation: 0 },
    { id: "c1", x: 1000, y: 0, rotation: 0 },
  ],
};
const walk = seatingWalk(layout);

describe("blockSeats", () => {
  it("takes N seats forwards from the target, past disabled ones", () => {
    expect(blockSeats(walk, "r1", 3)).toEqual({
      seatIds: ["r1", "r2", "r4"],
      fits: true,
    });
  });

  it("takes the window that ends with the run when the run ends first", () => {
    expect(blockSeats(walk, "r6", 3)).toEqual({
      seatIds: ["r5", "r6", "r7"],
      fits: true,
    });
  });

  it("passes over occupied seats only when asked", () => {
    const occupied = new Set(["r2", "r4"]);
    expect(blockSeats(walk, "r1", 3, { occupied })).toEqual({
      seatIds: ["r1", "r2", "r4"],
      fits: true,
    });
    expect(blockSeats(walk, "r1", 3, { occupied, skipOccupied: true })).toEqual(
      { seatIds: ["r1", "r5", "r6"], fits: true },
    );
    // From an occupied seat, the next free one on.
    expect(blockSeats(walk, "r2", 1, { occupied, skipOccupied: true })).toEqual(
      { seatIds: ["r5"], fits: true },
    );
  });

  it("gives what the run has when N do not fit", () => {
    const occupied = new Set(["r0", "r1", "r2", "r4"]);
    expect(blockSeats(walk, "r5", 4, { occupied, skipOccupied: true })).toEqual(
      { seatIds: ["r5", "r6", "r7"], fits: false },
    );
  });

  it("seats one person on a loose chair", () => {
    expect(blockSeats(walk, "c0", 1)).toEqual({ seatIds: ["c0"], fits: true });
    expect(blockSeats(walk, "c0", 2)).toEqual({ seatIds: ["c0"], fits: false });
    expect(
      blockSeats(walk, "c0", 1, {
        occupied: new Set(["c0"]),
        skipOccupied: true,
      }),
    ).toEqual({ seatIds: [], fits: false });
  });

  it("takes nothing on a disabled or unknown seat", () => {
    expect(blockSeats(walk, "r3", 1)).toEqual({ seatIds: [], fits: false });
    expect(blockSeats(walk, "nope", 1)).toEqual({ seatIds: [], fits: false });
    expect(blockSeats(walk, "r1", 0)).toEqual({ seatIds: [], fits: false });
  });
});

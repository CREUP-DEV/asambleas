import { describe, expect, it } from "vitest";
import {
  emptySeatingLayout,
  seatPoints,
  type SeatingLayout,
  type SeatingSeat,
  type SeatingTable,
} from "./layout";
import {
  LOOSE_CHAIRS_RUN,
  SEATING_RUNS,
  jumpRun,
  seatLabelParts,
  seatPieces,
  seatingRunKind,
  seatingWalk,
  stepSeat,
  walkOrder,
} from "./runs";

const seats = (prefix: string, count: number, disabled: number[] = []) =>
  Array.from({ length: count }, (_, index): SeatingSeat => ({
    id: `${prefix}${index}`,
    side: "front",
    index,
    ...(disabled.includes(index) ? { disabled: true } : {}),
  }));

const table = (
  id: string,
  run: string,
  x: number,
  y: number,
  tableSeats: SeatingSeat[],
  zone: SeatingTable["zone"] = "delegates",
): SeatingTable => ({
  id,
  shape: "rect",
  x,
  y,
  w: 180,
  h: 60,
  rotation: 0,
  zone,
  run,
  seats: tableSeats,
});

/** Two rows of two tables (the second interleaved), the Mesa and a chair. */
const layout: SeatingLayout = {
  ...emptySeatingLayout(),
  tables: [
    table("m", SEATING_RUNS.presiding, 0, 0, seats("m", 3), "presiding"),
    table("a1", "row-a", -90, 300, seats("a", 3)),
    table("b1", "row-b", -90, 600, seats("b", 3)),
    table("a2", "row-a", 90, 300, seats("A", 3, [1])),
    table("b2", "row-b", 90, 600, seats("B", 3)),
  ],
  chairs: [
    { id: "c0", x: 1000, y: 1000, rotation: 0, label: "Prensa" },
    { id: "c1", x: 1100, y: 1000, rotation: 0 },
  ],
};

describe("seatingWalk", () => {
  const walk = seatingWalk(layout);

  it("walks runs in the order of their first table, chairs last", () => {
    expect(walk.runs.map((run) => run.id)).toEqual([
      SEATING_RUNS.presiding,
      "row-a",
      "row-b",
      LOOSE_CHAIRS_RUN,
    ]);
    expect(walk.runs[1]!.seats.map((seat) => seat.id)).toEqual([
      "a0",
      "a1",
      "a2",
      "A0",
      "A1",
      "A2",
    ]);
    expect(walkOrder(walk).map((seat) => seat.id)).toHaveLength(17);
  });

  it("knows each seat's run, place, table and zone", () => {
    expect(walk.seats.get("A1")).toEqual({
      id: "A1",
      run: "row-a",
      runIndex: 1,
      position: 4,
      tableId: "a2",
      zone: "delegates",
      disabled: true,
      label: null,
    });
    expect(walk.seats.get("c0")).toMatchObject({
      run: LOOSE_CHAIRS_RUN,
      tableId: null,
      zone: null,
      label: "Prensa",
    });
  });

  it("names the templates' runs", () => {
    expect(seatingRunKind(SEATING_RUNS.outerU)).toBe("outer_u");
    expect(seatingRunKind(SEATING_RUNS.innerU)).toBe("inner_u");
    expect(seatingRunKind(SEATING_RUNS.presiding)).toBe("presiding");
    expect(seatingRunKind(LOOSE_CHAIRS_RUN)).toBe("loose");
    expect(seatingRunKind("row-a")).toBe("other");
  });
});

describe("keyboard", () => {
  const walk = seatingWalk(layout);
  const points = seatPoints(layout);

  it("steps along the run, past disabled seats, and stops at its ends", () => {
    expect(stepSeat(walk, "a2", 1)).toBe("A0");
    expect(stepSeat(walk, "A0", 1)).toBe("A2");
    expect(stepSeat(walk, "A0", 1, { includeDisabled: true })).toBe("A1");
    expect(stepSeat(walk, "A2", -1)).toBe("A0");
    expect(stepSeat(walk, "A2", 1)).toBeNull();
    expect(stepSeat(walk, "a0", -1)).toBeNull();
    expect(stepSeat(walk, "nope", 1)).toBeNull();
  });

  it("jumps to the nearest seat of the next or previous run", () => {
    // a1 sits at (-90, 365): the nearest of row-b is b1, 300 cm below.
    expect(jumpRun(walk, points, "a1", 1)).toBe("b1");
    expect(jumpRun(walk, points, "b1", -1)).toBe("a1");
    // From the Mesa's middle seat down to the first row: a2 and A0 are as
    // near; the earlier one in the run wins.
    expect(jumpRun(walk, points, "m1", 1)).toBe("a2");
    expect(jumpRun(walk, points, "m1", -1)).toBeNull();
    expect(jumpRun(walk, points, "c1", 1)).toBeNull();
    expect(jumpRun(walk, points, "B2", 1)).toBe("c0");
  });

  it("passes over disabled seats when jumping", () => {
    // A1 is right above B1, but disabled: A0 and A2 are as near.
    expect(jumpRun(walk, points, "B1", -1)).toBe("A0");
    expect(jumpRun(walk, points, "B1", -1, { includeDisabled: true })).toBe(
      "A1",
    );
  });
});

describe("seatLabelParts", () => {
  const walk = seatingWalk(layout);

  it("numbers seats along their run, disabled ones counted", () => {
    expect(seatLabelParts(walk, "A2")).toEqual({
      number: 6,
      run: { kind: "other", ordinal: 1 },
      label: null,
      disabled: false,
    });
    expect(seatLabelParts(walk, "B0")?.run).toEqual({
      kind: "other",
      ordinal: 2,
    });
    expect(seatLabelParts(walk, "m0")?.run).toEqual({
      kind: "presiding",
      ordinal: 1,
    });
    expect(seatLabelParts(walk, "c0")).toEqual({
      number: 1,
      run: { kind: "loose", ordinal: 1 },
      label: "Prensa",
      disabled: false,
    });
    expect(seatLabelParts(walk, "nope")).toBeNull();
  });
});

describe("seatPieces", () => {
  const walk = seatingWalk(layout);

  it("keeps seats of a run together across tables and disabled seats", () => {
    expect(seatPieces(walk, ["A2", "a2", "A0"])).toEqual([["a2", "A0", "A2"]]);
  });

  it("cuts at a free seat, another run and every loose chair", () => {
    expect(seatPieces(walk, ["a0", "a2", "b0", "c0", "c1"])).toEqual([
      ["a0"],
      ["a2"],
      ["b0"],
      ["c0"],
      ["c1"],
    ]);
    expect(seatPieces(walk, [])).toEqual([]);
    expect(seatPieces(walk, ["nope"])).toEqual([]);
  });
});

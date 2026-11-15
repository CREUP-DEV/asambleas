import { describe, expect, it } from "vitest";
import {
  emptySeatingLayout,
  enabledSeatIds,
  layoutBounds,
  layoutSeatIds,
  normalizeRotation,
  seatPoints,
  seatsLostByEdit,
  tableSeatPoint,
  type SeatingLayout,
  type SeatingTable,
} from "./layout";

const table = (over: Partial<SeatingTable> = {}): SeatingTable => ({
  id: "t1",
  shape: "rect",
  x: 0,
  y: 0,
  w: 180,
  h: 60,
  rotation: 0,
  zone: "delegates",
  run: "r1",
  seats: [
    { id: "s0", side: "front", index: 0 },
    { id: "s1", side: "front", index: 1 },
    { id: "s2", side: "front", index: 2 },
  ],
  ...over,
});

const room = (over: Partial<SeatingLayout> = {}): SeatingLayout => ({
  ...emptySeatingLayout(),
  tables: [table()],
  ...over,
});

describe("tableSeatPoint", () => {
  it("spreads a side's seats evenly along the table", () => {
    const t = table();
    expect(t.seats.map((seat) => tableSeatPoint(t, seat))).toEqual([
      { x: -60, y: 65, facing: 0 },
      { x: 0, y: 65, facing: 0 },
      { x: 60, y: 65, facing: 0 },
    ]);
  });

  it("seats each side facing the table", () => {
    const t = table({ seats: [] });
    expect(tableSeatPoint(t, { side: "back", index: 0 })).toEqual({
      x: 0,
      y: -65,
      facing: 180,
    });
    expect(tableSeatPoint(t, { side: "left", index: 0 })).toEqual({
      x: -125,
      y: 0,
      facing: 90,
    });
    expect(tableSeatPoint(t, { side: "right", index: 0 })).toEqual({
      x: 125,
      y: 0,
      facing: 270,
    });
  });

  it("turns with the table, clockwise", () => {
    const t = table({ x: 100, y: 100, rotation: 90 });
    // At 90° the front faces left and the seats run down the page.
    expect(tableSeatPoint(t, t.seats[0]!)).toEqual({
      x: 35,
      y: 40,
      facing: 90,
    });
    expect(tableSeatPoint(t, t.seats[2]!)).toEqual({
      x: 35,
      y: 160,
      facing: 90,
    });
  });

  it("places seats around a round table from the top, clockwise", () => {
    const round: SeatingTable = table({
      shape: "round",
      w: 120,
      h: 120,
      seats: [0, 1, 2, 3].map((index) => ({
        id: `a${index}`,
        side: "around" as const,
        index,
      })),
    });
    expect(round.seats.map((seat) => tableSeatPoint(round, seat))).toEqual([
      { x: 0, y: -95, facing: 180 },
      { x: 95, y: 0, facing: 270 },
      { x: 0, y: 95, facing: 0 },
      { x: -95, y: 0, facing: 90 },
    ]);
  });
});

describe("seats", () => {
  const layout = room({
    tables: [
      table({
        seats: [
          { id: "s0", side: "front", index: 0 },
          { id: "s1", side: "front", index: 1, disabled: true },
        ],
      }),
    ],
    chairs: [{ id: "c0", x: 500, y: 500, rotation: 45 }],
  });

  it("lists every seat, tables' then chairs'", () => {
    expect(layoutSeatIds(layout)).toEqual(["s0", "s1", "c0"]);
    expect([...enabledSeatIds(layout)]).toEqual(["s0", "c0"]);
  });

  it("places loose chairs where they are", () => {
    expect(seatPoints(layout).get("c0")).toEqual({
      x: 500,
      y: 500,
      facing: 45,
    });
  });

  it("finds the seats an edit takes away or disables", () => {
    const next = room({
      tables: [
        table({
          seats: [{ id: "s0", side: "front", index: 0, disabled: true }],
        }),
      ],
      chairs: [],
    });
    expect(seatsLostByEdit(layout, next)).toEqual(["s0", "c0"]);
    expect(seatsLostByEdit(next, layout)).toEqual([]);
  });

  it("measures the room, seats included", () => {
    expect(layoutBounds(emptySeatingLayout())).toBeNull();
    expect(layoutBounds(room())).toEqual({
      minX: -90,
      minY: -30,
      maxX: 90,
      maxY: 87.5,
    });
  });

  it("normalizes rotations", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
  });
});

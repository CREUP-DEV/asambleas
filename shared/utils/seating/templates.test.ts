import { describe, expect, it } from "vitest";
import {
  SEATING_SEAT_DIAMETER,
  SEATING_SEAT_PITCH,
  layoutSeatIds,
  seatPoints,
  seatsLostByEdit,
  tablePoint,
  type DoubleUParams,
  type SeatingLayout,
  type SeatingTable,
} from "./layout";
import { SEATING_RUNS, seatingWalk } from "./runs";
import {
  DEFAULT_DOUBLE_U_PARAMS,
  canGenerateTemplate,
  defaultDoubleULayout,
  doubleUCapacity,
  doubleUParamsProblem,
  generateSeatingLayout,
  regenerateSeatingLayout,
} from "./templates";

/** A deterministic id factory whose ids pass the entity id pattern. */
function counter(prefix = "a") {
  let next = 0;
  const factory = () => `${prefix}${String(++next).padStart(23, "0")}`;
  return Object.assign(factory, { calls: () => next });
}

const doubleU = (params: Partial<DoubleUParams> = {}) =>
  ({
    kind: "double_u",
    params: { ...DEFAULT_DOUBLE_U_PARAMS, ...params },
  }) as const;

/** The room's box of a table turned in steps of 90°. */
function box(table: SeatingTable) {
  const corners = [
    tablePoint(table, -table.w / 2, -table.h / 2),
    tablePoint(table, table.w / 2, table.h / 2),
  ];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}

function distanceToBox(
  point: { x: number; y: number },
  b: ReturnType<typeof box>,
) {
  const dx = Math.max(b.minX - point.x, 0, point.x - b.maxX);
  const dy = Math.max(b.minY - point.y, 0, point.y - b.maxY);
  return Math.hypot(dx, dy);
}

describe("the Doble U", () => {
  const layout = defaultDoubleULayout({ createId: counter() });

  it("holds between 100 and 120 seats by default", () => {
    const seats = layoutSeatIds(layout).length;
    expect(seats).toBe(doubleUCapacity(DEFAULT_DOUBLE_U_PARAMS));
    expect(seats).toBeGreaterThanOrEqual(100);
    expect(seats).toBeLessThanOrEqual(120);
  });

  it("puts the Mesa at the top, centred, behind its table facing the room", () => {
    const mesa = layout.tables[0]!;
    expect(mesa).toMatchObject({
      x: 0,
      y: 0,
      zone: "presiding",
      run: SEATING_RUNS.presiding,
    });
    expect(mesa.seats).toHaveLength(DEFAULT_DOUBLE_U_PARAMS.mesaSeats);
    const points = seatPoints(layout);
    for (const seat of mesa.seats) {
      const point = points.get(seat.id)!;
      expect(point.y).toBeLessThan(mesa.y);
      expect(point.facing).toBe(180);
    }
    const lowest = Math.min(
      ...layout.tables.slice(1).map((table) => box(table).minY),
    );
    expect(lowest).toBeGreaterThan(box(mesa).maxY);
  });

  it("makes the outer U's base the CEA's and everything else the delegations'", () => {
    const zones = layout.tables.map((table) => [table.slot, table.zone]);
    for (const [slot, zone] of zones) {
      if (slot!.startsWith("presiding")) expect(zone).toBe("presiding");
      else if (slot!.startsWith("outer-u:base")) expect(zone).toBe("cea");
      else expect(zone).toBe("delegates");
    }
    expect(layout.tables.filter((table) => table.zone === "cea")).toHaveLength(
      DEFAULT_DOUBLE_U_PARAMS.outerBaseTables,
    );
  });

  it("seats everyone on the outer side of the U, facing in", () => {
    const points = seatPoints(layout);
    for (const table of layout.tables.slice(1)) {
      for (const seat of table.seats) {
        const point = points.get(seat.id)!;
        const [, part] = table.slot!.split(":");
        if (part === "left") {
          expect(point.x).toBeLessThan(table.x);
          expect(point.facing).toBe(90);
        } else if (part === "right") {
          expect(point.x).toBeGreaterThan(table.x);
          expect(point.facing).toBe(270);
        } else {
          expect(point.y).toBeGreaterThan(table.y);
          expect(point.facing).toBe(0);
        }
      }
    }
  });

  it("walks each U down one arm, along the base and up the other, seat by seat", () => {
    const walk = seatingWalk(layout);
    const points = seatPoints(layout);
    expect(walk.runs.map((run) => run.id)).toEqual([
      SEATING_RUNS.presiding,
      SEATING_RUNS.outerU,
      SEATING_RUNS.innerU,
    ]);
    for (const run of walk.runs) {
      for (let index = 1; index < run.seats.length; index += 1) {
        const a = points.get(run.seats[index - 1]!.id)!;
        const b = points.get(run.seats[index]!.id)!;
        // Neighbours along a table or across a corner.
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(
          2.5 * SEATING_SEAT_PITCH,
        );
      }
    }
    const outer = walk.runs[1]!.seats.map((seat) => points.get(seat.id)!);
    // Starts at the open end of the left arm and ends at the right one's.
    expect(outer[0]!.x).toBeLessThan(0);
    expect(outer.at(-1)!.x).toBeGreaterThan(0);
    expect(outer[0]!.y).toBe(outer.at(-1)!.y);
  });

  it("keeps tables apart and every seat clear of other tables", () => {
    const boxes = layout.tables.map(box);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
      }
    }
    const points = seatPoints(layout);
    for (const seatId of layoutSeatIds(layout)) {
      const point = points.get(seatId)!;
      for (const b of boxes) {
        expect(distanceToBox(point, b)).toBeGreaterThanOrEqual(
          SEATING_SEAT_DIAMETER / 2,
        );
      }
    }
    const all = [...points.values()];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        expect(
          Math.hypot(all[i]!.x - all[j]!.x, all[i]!.y - all[j]!.y),
        ).toBeGreaterThanOrEqual(SEATING_SEAT_DIAMETER);
      }
    }
  });

  it("stays on the 10 cm grid", () => {
    for (const table of layout.tables) {
      expect(Math.abs(table.x % 10)).toBe(0);
      expect(Math.abs(table.y % 10)).toBe(0);
    }
  });

  it("leaves the inner U out when it has no tables", () => {
    const single = generateSeatingLayout(
      doubleU({ innerArmTables: 0, innerBaseTables: 0 }),
      { createId: counter() },
    );
    expect(single.tables.some((t) => t.run === SEATING_RUNS.innerU)).toBe(
      false,
    );
  });

  it("refuses numbers that do not fit", () => {
    expect(doubleUParamsProblem(DEFAULT_DOUBLE_U_PARAMS)).toBeNull();
    expect(
      doubleUParamsProblem({
        ...DEFAULT_DOUBLE_U_PARAMS,
        innerBaseTables: 5,
      }),
    ).toMatch(/dos mesas más/);
    expect(
      doubleUParamsProblem({ ...DEFAULT_DOUBLE_U_PARAMS, mesaSeats: 6 }),
    ).not.toBeNull();
    expect(
      doubleUParamsProblem({ ...DEFAULT_DOUBLE_U_PARAMS, gap: 155 }),
    ).not.toBeNull();
    expect(() => generateSeatingLayout(doubleU({ outerArmTables: 0 }))).toThrow(
      RangeError,
    );
  });

  it("generates only the Doble U and Vacía today", () => {
    expect(canGenerateTemplate(doubleU())).toBe(true);
    expect(canGenerateTemplate({ kind: "empty", params: {} })).toBe(true);
    expect(canGenerateTemplate({ kind: "rows", params: {} })).toBe(false);
    expect(() => generateSeatingLayout({ kind: "rows", params: {} })).toThrow(
      RangeError,
    );
    expect(generateSeatingLayout({ kind: "empty", params: {} }).tables).toEqual(
      [],
    );
  });

  it("mints ids from the factory it is given", () => {
    const again = defaultDoubleULayout({ createId: counter() });
    expect(again).toEqual(layout);
    expect(new Set(layoutSeatIds(layout)).size).toBe(
      layoutSeatIds(layout).length,
    );
  });
});

describe("regenerateSeatingLayout", () => {
  const base = (): SeatingLayout => {
    const layout = defaultDoubleULayout({ createId: counter("a") });
    const firstSeat = layout.tables[1]!.seats[0]!;
    firstSeat.disabled = true;
    firstSeat.label = "Columna";
    layout.chairs.push({
      id: "c".padEnd(24, "0"),
      x: 900,
      y: 900,
      rotation: 0,
    });
    layout.fixtures.push({
      id: "f".padEnd(24, "0"),
      kind: "screen",
      x: 0,
      y: -200,
      w: 300,
      h: 20,
      rotation: 0,
    });
    layout.tables.push({
      id: "h".padEnd(24, "0"),
      shape: "round",
      x: 2000,
      y: 2000,
      w: 120,
      h: 120,
      rotation: 0,
      zone: "free",
      run: "press",
      seats: [{ id: "s".padEnd(24, "0"), side: "around", index: 0 }],
    });
    return layout;
  };

  it("keeps every id with the same numbers and mints none", () => {
    const previous = base();
    const ids = counter("b");
    const next = regenerateSeatingLayout(previous, previous.template, {
      createId: ids,
    });
    expect(ids.calls()).toBe(0);
    expect(next).toEqual(previous);
  });

  it("keeps the seats whose table, side and index survive", () => {
    const previous = base();
    const ids = counter("b");
    const next = regenerateSeatingLayout(
      previous,
      doubleU({ seatsPerTable: 2 }),
      {
        createId: ids,
      },
    );
    expect(ids.calls()).toBe(0);
    const kept = new Set(layoutSeatIds(next));
    const lost = seatsLostByEdit(previous, next);
    for (const table of previous.tables.slice(1, -1)) {
      for (const seat of table.seats) {
        if (seat.index === 2) expect(lost).toContain(seat.id);
        else expect(kept.has(seat.id)).toBe(true);
      }
    }
    // The Mesa's seats are its own number.
    for (const seat of previous.tables[0]!.seats) {
      expect(kept.has(seat.id)).toBe(true);
    }
    expect(next.tables[1]!.seats[0]).toMatchObject({
      disabled: true,
      label: "Columna",
    });
  });

  it("mints ids only for new tables and seats", () => {
    const previous = base();
    const ids = counter("b");
    const next = regenerateSeatingLayout(
      previous,
      doubleU({ outerArmTables: 8 }),
      { createId: ids },
    );
    // Two new tables (one per arm) of three seats each.
    expect(ids.calls()).toBe(2 * (1 + 3));
    expect(layoutSeatIds(next)).toEqual(
      expect.arrayContaining(layoutSeatIds(previous)),
    );
    expect(seatsLostByEdit(previous, next)).toEqual([]);
  });

  it("keeps loose chairs, landmarks and tables added by hand", () => {
    const previous = base();
    const next = regenerateSeatingLayout(previous, {
      kind: "empty",
      params: {},
    });
    expect(next.tables.map((table) => table.id)).toEqual(["h".padEnd(24, "0")]);
    expect(next.chairs).toEqual(previous.chairs);
    expect(next.fixtures).toEqual(previous.fixtures);
    expect(next.template).toEqual({ kind: "empty", params: {} });
  });
});

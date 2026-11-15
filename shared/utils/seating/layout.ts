import { createId } from "@paralleldrive/cuid2";

/**
 * The room of the seating view («Sala», docs/seating-plan.md, section 4):
 * tables with their seats, loose chairs and landmarks, in centimetres. Pure,
 * shared by the server, which validates every write with
 * shared/utils/schemas/seating.ts, and the page that draws it.
 *
 * Coordinates: x grows to the right and y downwards, as in SVG, on a 10 cm
 * grid. A table's (x, y) is its centre; `w` runs along its own x axis and
 * `h` along its own y axis; `rotation` turns it clockwise about its centre,
 * in degrees. At rotation 0 a table faces down the page, towards the room,
 * as the Mesa does from the top: its `front` is its lower edge (+y), its
 * `back` the upper edge, `left` and `right` its ends. A seat's `index`
 * counts along its side in the table's own axis (left to right at rotation
 * 0 on `front` and `back`, top to bottom on `left` and `right`, clockwise
 * from the top on `around`).
 *
 * The JSON is stored as it is (seating_plans.layout): it carries
 * `schemaVersion` from day one, and a change of shape follows the
 * two-release rule (AGENTS.md, "Database And Migrations").
 */

export const SEATING_LAYOUT_SCHEMA_VERSION = 1;

/** The grid tables and chairs snap to, in centimetres. */
export const SEATING_GRID = 10;
/** A table's default size: 180 × 60 cm. */
export const SEATING_TABLE_LENGTH = 180;
export const SEATING_TABLE_DEPTH = 60;
/** The room one person takes along a table. */
export const SEATING_SEAT_PITCH = 60;
/** The circle a seat is drawn as. */
export const SEATING_SEAT_DIAMETER = 45;
/** From a table's edge to the centre of a seat beside it. */
export const SEATING_SEAT_OFFSET = 35;

export const SEATING_TABLE_SHAPES = ["rect", "round"] as const;
export type SeatingTableShape = (typeof SEATING_TABLE_SHAPES)[number];

/**
 * What a table is for, which Proponer reparto reads: the Mesa's table
 * (`presiding`), the CEA's (`cea`), the delegations' (`delegates`), or
 * `free`, left to place by hand.
 */
export const SEATING_ZONES = ["presiding", "cea", "delegates", "free"] as const;
export type SeatingZone = (typeof SEATING_ZONES)[number];

export const SEATING_SIDES = [
  "front",
  "back",
  "left",
  "right",
  "around",
] as const;
export type SeatingSide = (typeof SEATING_SIDES)[number];

/** Landmarks that are not seats. */
export const SEATING_FIXTURE_KINDS = [
  "screen",
  "door",
  "windows",
  "banner",
  "lectern",
  "label",
] as const;
export type SeatingFixtureKind = (typeof SEATING_FIXTURE_KINDS)[number];

/**
 * The templates a room is generated from. Only `double_u` and `empty` have a
 * generator today; the others are accepted already, with loose parameters,
 * so a layout saved by the release that brings them still parses after a
 * rollback.
 */
export const SEATING_TEMPLATE_KINDS = [
  "double_u",
  "u",
  "rows",
  "islands",
  "empty",
] as const;
export type SeatingTemplateKind = (typeof SEATING_TEMPLATE_KINDS)[number];

export interface SeatingSeat {
  /** Stable (cuid2): assignments point at it. Never derived from the place. */
  id: string;
  side: SeatingSide;
  index: number;
  /** A seat nobody may take (a pillar, an aisle). */
  disabled?: boolean;
  label?: string;
}

export interface SeatingTable {
  id: string;
  /**
   * Where the template put it ("outer-u:left:2"), so regenerating with new
   * parameters keeps its id and its seats' ids. A table added by hand has
   * none and regenerating leaves it alone.
   */
  slot?: string;
  shape: SeatingTableShape;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  zone: SeatingZone;
  /**
   * The row it belongs to (SEATING_RUNS for the templates' own). The seats
   * of a run are walked in the order of its tables in `tables` and of each
   * table's `seats`.
   */
  run: string;
  /** In walk order along the run. */
  seats: SeatingSeat[];
}

/** A loose seat anywhere («alguien suelto»): its id is the seat's id. */
export interface SeatingChair {
  id: string;
  x: number;
  y: number;
  /** Where its occupant looks, clockwise from facing up the page. */
  rotation: number;
  label?: string;
}

export interface SeatingFixture {
  id: string;
  kind: SeatingFixtureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  label?: string;
}

/** The Doble U's numbers (docs/seating-plan.md, section 4). */
export interface DoubleUParams {
  /** Tables on each arm of the outer U. */
  outerArmTables: number;
  /** Tables on the base of the outer U: the CEA's. */
  outerBaseTables: number;
  /** Tables on each arm of the inner U (0 with no inner U). */
  innerArmTables: number;
  innerBaseTables: number;
  seatsPerTable: 2 | 3;
  /** Seats at the Mesa's table. */
  mesaSeats: number;
  /** From the outer U's base to the inner U's, chairs included, in cm. */
  gap: number;
}

export type SeatingTemplateParams = Record<string, number | boolean | string>;

export type SeatingTemplate =
  | { kind: "double_u"; params: DoubleUParams }
  | { kind: "empty"; params: Record<string, never> }
  | { kind: "u" | "rows" | "islands"; params: SeatingTemplateParams };

export interface SeatingLayout {
  schemaVersion: typeof SEATING_LAYOUT_SCHEMA_VERSION;
  tables: SeatingTable[];
  chairs: SeatingChair[];
  fixtures: SeatingFixture[];
  /** What it was generated from, so its numbers can be changed later. */
  template: SeatingTemplate;
}

/** Makes the ids of new tables and seats; tests pass a counter. */
export type SeatingIdFactory = () => string;

export const defaultSeatingIdFactory: SeatingIdFactory = createId;

/** A room with nothing in it («Vacía»). */
export function emptySeatingLayout(): SeatingLayout {
  return {
    schemaVersion: SEATING_LAYOUT_SCHEMA_VERSION,
    tables: [],
    chairs: [],
    fixtures: [],
    template: { kind: "empty", params: {} },
  };
}

// Seats ----------------------------------------------------------------------

/** Every seat of the room: the tables' in order, then the loose chairs. */
export function layoutSeatIds(layout: SeatingLayout): string[] {
  return [
    ...layout.tables.flatMap((table) => table.seats.map((seat) => seat.id)),
    ...layout.chairs.map((chair) => chair.id),
  ];
}

/** The seats a person may take: every chair and every seat not disabled. */
export function enabledSeatIds(layout: SeatingLayout): Set<string> {
  const ids = new Set<string>();
  for (const table of layout.tables) {
    for (const seat of table.seats) if (!seat.disabled) ids.add(seat.id);
  }
  for (const chair of layout.chairs) ids.add(chair.id);
  return ids;
}

/**
 * The seats that stop taking people when `previous` becomes `next`: gone,
 * or disabled. The server refuses such an edit while one of them is
 * occupied, unless the request confirms it (409 `seating_seats_occupied`).
 */
export function seatsLostByEdit(
  previous: SeatingLayout,
  next: SeatingLayout,
): string[] {
  const kept = enabledSeatIds(next);
  return [...enabledSeatIds(previous)].filter((id) => !kept.has(id));
}

// Geometry -------------------------------------------------------------------

/** Where a seat is and where its occupant looks (clockwise, 0 = up the page). */
export interface SeatPoint {
  x: number;
  y: number;
  facing: number;
}

export function normalizeRotation(degrees: number): number {
  const turned = degrees % 360;
  return turned < 0 ? turned + 360 : turned;
}

const round = (value: number) => Math.round(value * 100) / 100 || 0;

/** A point of the table's own frame, in the room. */
export function tablePoint(
  table: Pick<SeatingTable, "x" | "y" | "rotation">,
  localX: number,
  localY: number,
): { x: number; y: number } {
  const angle = (normalizeRotation(table.rotation) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: round(table.x + localX * cos - localY * sin),
    y: round(table.y + localX * sin + localY * cos),
  };
}

/** Seats on one side of a table: its count, or past its highest index. */
function sideCount(table: SeatingTable, side: SeatingSide): number {
  let count = 0;
  let highest = -1;
  for (const seat of table.seats) {
    if (seat.side !== side) continue;
    count += 1;
    highest = Math.max(highest, seat.index);
  }
  return Math.max(count, highest + 1);
}

/** Where a seat of a table is, from its side and index. */
export function tableSeatPoint(
  table: SeatingTable,
  seat: Pick<SeatingSeat, "side" | "index">,
): SeatPoint {
  const count = Math.max(1, sideCount(table, seat.side));
  const along = (length: number) =>
    ((seat.index + 0.5) * length) / count - length / 2;
  const rotation = normalizeRotation(table.rotation);
  let local: { x: number; y: number };
  let facing: number;
  switch (seat.side) {
    case "front":
      local = { x: along(table.w), y: table.h / 2 + SEATING_SEAT_OFFSET };
      facing = rotation;
      break;
    case "back":
      local = { x: along(table.w), y: -(table.h / 2 + SEATING_SEAT_OFFSET) };
      facing = rotation + 180;
      break;
    case "left":
      local = { x: -(table.w / 2 + SEATING_SEAT_OFFSET), y: along(table.h) };
      facing = rotation + 90;
      break;
    case "right":
      local = { x: table.w / 2 + SEATING_SEAT_OFFSET, y: along(table.h) };
      facing = rotation + 270;
      break;
    case "around": {
      const radius = Math.max(table.w, table.h) / 2 + SEATING_SEAT_OFFSET;
      const step = 360 / count;
      const angle = (seat.index * step * Math.PI) / 180;
      local = { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) };
      facing = rotation + seat.index * step + 180;
      break;
    }
  }
  return {
    ...tablePoint(table, local.x, local.y),
    facing: round(normalizeRotation(facing)),
  };
}

/** Every seat's place, tables' and chairs', by seat id. */
export function seatPoints(layout: SeatingLayout): Map<string, SeatPoint> {
  const points = new Map<string, SeatPoint>();
  for (const table of layout.tables) {
    for (const seat of table.seats) {
      points.set(seat.id, tableSeatPoint(table, seat));
    }
  }
  for (const chair of layout.chairs) {
    points.set(chair.id, {
      x: chair.x,
      y: chair.y,
      facing: normalizeRotation(chair.rotation),
    });
  }
  return points;
}

export interface SeatingBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The box around everything drawn, seats included; null for an empty room. */
export function layoutBounds(layout: SeatingLayout): SeatingBounds | null {
  let bounds: SeatingBounds | null = null;
  const add = (x: number, y: number, margin = 0) => {
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, x - margin),
          minY: Math.min(bounds.minY, y - margin),
          maxX: Math.max(bounds.maxX, x + margin),
          maxY: Math.max(bounds.maxY, y + margin),
        }
      : {
          minX: x - margin,
          minY: y - margin,
          maxX: x + margin,
          maxY: y + margin,
        };
  };
  const addBox = (
    box: Pick<SeatingTable, "x" | "y" | "w" | "h" | "rotation">,
  ) => {
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const corner = tablePoint(box, (dx * box.w) / 2, (dy * box.h) / 2);
      add(corner.x, corner.y);
    }
  };
  const seatRadius = SEATING_SEAT_DIAMETER / 2;
  for (const table of layout.tables) {
    addBox(table);
    for (const seat of table.seats) {
      const point = tableSeatPoint(table, seat);
      add(point.x, point.y, seatRadius);
    }
  }
  for (const chair of layout.chairs) add(chair.x, chair.y, seatRadius);
  for (const fixture of layout.fixtures) addBox(fixture);
  return bounds;
}

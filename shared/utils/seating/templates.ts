import {
  SEATING_LAYOUT_SCHEMA_VERSION,
  SEATING_SEAT_PITCH,
  SEATING_TABLE_DEPTH,
  SEATING_TABLE_LENGTH,
  defaultSeatingIdFactory,
  type DoubleUParams,
  type SeatingIdFactory,
  type SeatingLayout,
  type SeatingSeat,
  type SeatingSide,
  type SeatingTable,
  type SeatingTemplate,
  type SeatingZone,
} from "./layout";
import { SEATING_RUNS } from "./runs";

/**
 * The templates a room is generated from (docs/seating-plan.md, section 4):
 * the Doble U, CREUP's usual room, and Vacía. Generating builds the tables
 * and seats without ids; `generateSeatingLayout` mints them all and
 * `regenerateSeatingLayout` keeps the id of every table and seat that
 * survives a change of numbers, so the people seated there stay.
 */

/**
 * The Doble U's limits. The outer U's base must be wide enough for the inner
 * U's chairs to clear the outer U's tables (MIN_U_CLEARANCE,
 * minOuterBaseTables): two tables more than the inner U's today.
 */
export const DOUBLE_U_LIMITS = {
  outerArmTables: { min: 1, max: 15 },
  outerBaseTables: { min: 1, max: 15 },
  innerArmTables: { min: 0, max: 15 },
  innerBaseTables: { min: 0, max: 13 },
  seatsPerTable: { min: 2, max: 3 },
  mesaSeats: { min: 3, max: 5 },
  gap: { min: 120, max: 500, step: 10 },
} as const;

/**
 * About 105 seats: 60 on the outer U (18 of them the CEA's base), 42 on the
 * inner U and 3 at the Mesa, for the 90-odd people of an AGO.
 */
export const DEFAULT_DOUBLE_U_PARAMS: DoubleUParams = {
  outerArmTables: 7,
  outerBaseTables: 6,
  innerArmTables: 5,
  innerBaseTables: 4,
  seatsPerTable: 3,
  mesaSeats: 3,
  gap: 150,
};

/** Free floor between the outer U's tables and the inner U's chairs, per side. */
export const MIN_U_CLEARANCE = 120;

/** Free floor between the Mesa's table and the nearest U. */
export const MESA_CLEARANCE = 300;

/**
 * What is wrong with a Doble U's numbers: a code, the number at fault and
 * the values that word it. The client translates it
 * (`seating.doubleU.problems`); the API's schema refuses with the code.
 *
 * - `range`: a number outside DOUBLE_U_LIMITS (`min`, `max`);
 * - `gap_step`: a gap that is not a multiple of its step (`step`);
 * - `base`: an outer base too short for the inner U's chairs to clear the
 *   outer U's tables by MIN_U_CLEARANCE on each side (`count`, the fewest
 *   tables it takes).
 */
export interface DoubleUParamsProblem {
  code: "range" | "gap_step" | "base";
  field: keyof DoubleUParams;
  values: Record<string, number>;
}

/**
 * The fewest tables on the outer U's base around an inner U whose base has
 * `innerBaseTables`: the inner base, its two arms' depth and the clearance
 * on each side, in whole tables.
 */
export function minOuterBaseTables(innerBaseTables: number): number {
  return Math.ceil(
    (innerBaseTables * SEATING_TABLE_LENGTH +
      2 * SEATING_TABLE_DEPTH +
      2 * MIN_U_CLEARANCE) /
      SEATING_TABLE_LENGTH,
  );
}

/** What is wrong with a Doble U's numbers, or null when they make a room. */
export function doubleUParamsProblem(
  params: DoubleUParams,
): DoubleUParamsProblem | null {
  for (const [key, limit] of Object.entries(DOUBLE_U_LIMITS)) {
    const field = key as keyof DoubleUParams;
    const value = params[field];
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      return {
        code: "range",
        field,
        values: { min: limit.min, max: limit.max },
      };
    }
  }
  if (params.gap % DOUBLE_U_LIMITS.gap.step !== 0) {
    return {
      code: "gap_step",
      field: "gap",
      values: { step: DOUBLE_U_LIMITS.gap.step },
    };
  }
  const hasInner = params.innerArmTables > 0 || params.innerBaseTables > 0;
  const count = minOuterBaseTables(params.innerBaseTables);
  if (hasInner && params.outerBaseTables < count) {
    return { code: "base", field: "outerBaseTables", values: { count } };
  }
  return null;
}

/** The seats a Doble U holds, the Mesa's included. */
export function doubleUCapacity(params: DoubleUParams): number {
  const tables =
    2 * params.outerArmTables +
    params.outerBaseTables +
    2 * params.innerArmTables +
    params.innerBaseTables;
  return tables * params.seatsPerTable + params.mesaSeats;
}

// Skeletons ------------------------------------------------------------------

/** A table as a template places it, before it has ids. */
interface TableSkeleton extends Omit<SeatingTable, "id" | "seats" | "slot"> {
  slot: string;
  seats: { side: SeatingSide; index: number }[];
}

const seatsAlong = (side: SeatingSide, count: number) =>
  Array.from({ length: count }, (_, index) => ({ side, index }));

/**
 * One U: arms and base, everyone on the outer side facing in. Each table is
 * turned so that its `front` faces out and its seats run along the walk:
 * down the left arm from the open end, along the base from left to right,
 * up the right arm. `bottom` is the outer edge of the base; the U opens
 * upwards, towards the Mesa.
 */
function uSkeleton(options: {
  run: string;
  armTables: number;
  baseTables: number;
  seatsPerTable: number;
  bottom: number;
  baseZone: SeatingZone;
}): TableSkeleton[] {
  const T = SEATING_TABLE_LENGTH;
  const D = SEATING_TABLE_DEPTH;
  const width = options.baseTables * T;
  const table = (
    slot: string,
    x: number,
    y: number,
    rotation: number,
    zone: SeatingZone,
  ): TableSkeleton => ({
    slot: `${options.run}:${slot}`,
    shape: "rect",
    x,
    y,
    w: T,
    h: D,
    rotation,
    zone,
    run: options.run,
    seats: seatsAlong("front", options.seatsPerTable),
  });
  const armY = (k: number) => options.bottom - T / 2 - k * T;
  const tables: TableSkeleton[] = [];
  // Left arm, from the open end down to the base: k counts from the corner.
  for (let k = options.armTables - 1; k >= 0; k -= 1) {
    tables.push(
      table(`left:${k}`, -width / 2 - D / 2, armY(k), 90, "delegates"),
    );
  }
  for (let j = 0; j < options.baseTables; j += 1) {
    tables.push(
      table(
        `base:${j}`,
        -width / 2 + T / 2 + j * T,
        options.bottom - D / 2,
        0,
        options.baseZone,
      ),
    );
  }
  for (let k = 0; k < options.armTables; k += 1) {
    tables.push(
      table(`right:${k}`, width / 2 + D / 2, armY(k), 270, "delegates"),
    );
  }
  return tables;
}

/** The top edge of a U's tables. */
function uTop(tables: readonly TableSkeleton[]): number {
  return Math.min(
    ...tables.map((table) =>
      table.rotation === 0 ? table.y - table.h / 2 : table.y - table.w / 2,
    ),
  );
}

/**
 * The Doble U (docs/seating-plan.md, section 4): the Mesa's table at the top
 * facing the room, the Mesa behind it; below it two nested U shapes open
 * towards it, everyone on the outer side of the tables facing in. The outer
 * U's base, opposite the Mesa, is the CEA's. The Mesa's table is centred at
 * (0, 0).
 */
function doubleUSkeleton(params: DoubleUParams): TableSkeleton[] {
  const problem = doubleUParamsProblem(params);
  if (problem) {
    throw new RangeError(`Doble U: ${problem.code} (${problem.field})`);
  }
  const T = SEATING_TABLE_LENGTH;
  const D = SEATING_TABLE_DEPTH;
  // Laid out from the top of the outer U's arms (y = 0), then moved.
  const outerBottom = params.outerArmTables * T;
  const outer = uSkeleton({
    run: SEATING_RUNS.outerU,
    armTables: params.outerArmTables,
    baseTables: params.outerBaseTables,
    seatsPerTable: params.seatsPerTable,
    bottom: outerBottom,
    baseZone: "cea",
  });
  const inner =
    params.innerArmTables > 0 || params.innerBaseTables > 0
      ? uSkeleton({
          run: SEATING_RUNS.innerU,
          armTables: params.innerArmTables,
          baseTables: params.innerBaseTables,
          seatsPerTable: params.seatsPerTable,
          bottom: outerBottom - D - params.gap,
          baseZone: "delegates",
        })
      : [];
  const top = Math.min(uTop(outer), ...(inner.length ? [uTop(inner)] : []));
  const mesaY = top - MESA_CLEARANCE - D / 2;
  const mesa: TableSkeleton = {
    slot: `${SEATING_RUNS.presiding}:0`,
    shape: "rect",
    x: 0,
    y: mesaY,
    w: params.mesaSeats * SEATING_SEAT_PITCH,
    h: D,
    rotation: 0,
    zone: "presiding",
    run: SEATING_RUNS.presiding,
    seats: seatsAlong("back", params.mesaSeats),
  };
  return [mesa, ...outer, ...inner].map((table) => ({
    ...table,
    y: table.y - mesaY,
  }));
}

function templateSkeleton(template: SeatingTemplate): TableSkeleton[] {
  switch (template.kind) {
    case "double_u":
      return doubleUSkeleton(template.params);
    case "empty":
      return [];
    default:
      throw new RangeError(
        `No hay generador para la plantilla ${template.kind}`,
      );
  }
}

/** Whether this release can generate a template's tables. */
export function canGenerateTemplate(template: SeatingTemplate): boolean {
  return template.kind === "double_u" || template.kind === "empty";
}

// Layouts --------------------------------------------------------------------

export interface SeatingGenerateOptions {
  createId?: SeatingIdFactory;
}

/**
 * Turns skeletons into tables: a table whose slot `previous` holds keeps
 * that table's id, and each of its seats whose (side, index) survives keeps
 * its id, `disabled` and `label`. Ids are minted only for what is new.
 */
function materialize(
  skeletons: readonly TableSkeleton[],
  previous: readonly SeatingTable[],
  createId: SeatingIdFactory,
): SeatingTable[] {
  const bySlot = new Map(
    previous.flatMap((table) => (table.slot ? [[table.slot, table]] : [])),
  );
  return skeletons.map((skeleton) => {
    const old = bySlot.get(skeleton.slot);
    const id = old?.id ?? createId();
    const seats = skeleton.seats.map((place): SeatingSeat => {
      const kept = old?.seats.find(
        (seat) => seat.side === place.side && seat.index === place.index,
      );
      if (!kept) return { id: createId(), ...place };
      return {
        id: kept.id,
        ...place,
        ...(kept.disabled ? { disabled: true } : {}),
        ...(kept.label ? { label: kept.label } : {}),
      };
    });
    return { id, ...skeleton, seats };
  });
}

/** A new room from a template, every id new. */
export function generateSeatingLayout(
  template: SeatingTemplate,
  options: SeatingGenerateOptions = {},
): SeatingLayout {
  const createId = options.createId ?? defaultSeatingIdFactory;
  return {
    schemaVersion: SEATING_LAYOUT_SCHEMA_VERSION,
    tables: materialize(templateSkeleton(template), [], createId),
    chairs: [],
    fixtures: [],
    template,
  };
}

/** The Doble U with its default numbers. */
export function defaultDoubleULayout(
  options: SeatingGenerateOptions = {},
): SeatingLayout {
  return generateSeatingLayout(
    { kind: "double_u", params: { ...DEFAULT_DOUBLE_U_PARAMS } },
    options,
  );
}

/**
 * The room generated again from new numbers or another template. Every
 * table and seat that survives keeps its id (a seat survives when its table's
 * slot and its own side and index do), and so its occupant; tables added by
 * hand, loose chairs and landmarks stay as they are. Seats that go are
 * listed by seatsLostByEdit.
 */
export function regenerateSeatingLayout(
  previous: SeatingLayout,
  template: SeatingTemplate,
  options: SeatingGenerateOptions = {},
): SeatingLayout {
  const createId = options.createId ?? defaultSeatingIdFactory;
  return {
    schemaVersion: SEATING_LAYOUT_SCHEMA_VERSION,
    tables: [
      ...materialize(templateSkeleton(template), previous.tables, createId),
      ...previous.tables.filter((table) => !table.slot),
    ],
    chairs: previous.chairs.map((chair) => ({ ...chair })),
    fixtures: previous.fixtures.map((fixture) => ({ ...fixture })),
    template,
  };
}

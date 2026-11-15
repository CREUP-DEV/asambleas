import type { SeatPoint, SeatingLayout, SeatingZone } from "./layout";

/**
 * Runs (docs/seating-plan.md, section 4): the rows a room's seats are walked
 * along, in order. One per U (down one arm, along the base, up the other),
 * one for the Mesa; loose chairs make a run of their own, last. Runs drive
 * Proponer reparto, placing N seats in a row, the keyboard and the seats'
 * numbers («Asiento 12, U exterior»).
 *
 * A run's seats are those of its tables in the order of `layout.tables`,
 * each table's in the order of its `seats`; runs come in the order their
 * first table does.
 */

/** The runs the templates make; a hand-made row may take any other id. */
export const SEATING_RUNS = {
  presiding: "presiding",
  outerU: "outer-u",
  innerU: "inner-u",
} as const;

/** The run of the loose chairs. Never a table's. */
export const LOOSE_CHAIRS_RUN = "loose";

/** What a run is, for its name: the client words it. */
export type SeatingRunKind =
  "presiding" | "outer_u" | "inner_u" | "loose" | "other";

export function seatingRunKind(runId: string): SeatingRunKind {
  switch (runId) {
    case SEATING_RUNS.presiding:
      return "presiding";
    case SEATING_RUNS.outerU:
      return "outer_u";
    case SEATING_RUNS.innerU:
      return "inner_u";
    case LOOSE_CHAIRS_RUN:
      return "loose";
    default:
      return "other";
  }
}

export interface WalkSeat {
  id: string;
  run: string;
  /** The run's place in SeatingWalk.runs. */
  runIndex: number;
  /** The seat's place in its run, disabled seats included. */
  position: number;
  /** Null for a loose chair. */
  tableId: string | null;
  /** Null for a loose chair. */
  zone: SeatingZone | null;
  disabled: boolean;
  label: string | null;
}

export interface WalkRun {
  id: string;
  kind: SeatingRunKind;
  seats: WalkSeat[];
}

/** The room's runs and every seat's place in them. Build it once per layout. */
export interface SeatingWalk {
  runs: WalkRun[];
  seats: Map<string, WalkSeat>;
}

export function seatingWalk(layout: SeatingLayout): SeatingWalk {
  const runs: WalkRun[] = [];
  const byId = new Map<string, WalkRun>();
  const runFor = (id: string) => {
    let run = byId.get(id);
    if (!run) {
      run = { id, kind: seatingRunKind(id), seats: [] };
      byId.set(id, run);
      runs.push(run);
    }
    return run;
  };
  for (const table of layout.tables) {
    const run = runFor(table.run);
    for (const seat of table.seats) {
      run.seats.push({
        id: seat.id,
        run: run.id,
        runIndex: runs.indexOf(run),
        position: run.seats.length,
        tableId: table.id,
        zone: table.zone,
        disabled: Boolean(seat.disabled),
        label: seat.label ?? null,
      });
    }
  }
  if (layout.chairs.length) {
    const run: WalkRun = { id: LOOSE_CHAIRS_RUN, kind: "loose", seats: [] };
    runs.push(run);
    for (const chair of layout.chairs) {
      run.seats.push({
        id: chair.id,
        run: run.id,
        runIndex: runs.length - 1,
        position: run.seats.length,
        tableId: null,
        zone: null,
        disabled: false,
        label: chair.label ?? null,
      });
    }
  }
  const seats = new Map<string, WalkSeat>();
  for (const run of runs)
    for (const seat of run.seats) seats.set(seat.id, seat);
  return { runs, seats };
}

/** Seats in walk order: by run, then along it. */
export function compareWalk(a: WalkSeat, b: WalkSeat): number {
  return a.runIndex - b.runIndex || a.position - b.position;
}

/** Every seat of the room in walk order. */
export function walkOrder(walk: SeatingWalk): WalkSeat[] {
  return walk.runs.flatMap((run) => run.seats);
}

// Keyboard -------------------------------------------------------------------

export interface SeatStepOptions {
  /** Stop on disabled seats too (to enable one again). */
  includeDisabled?: boolean;
}

/**
 * The next seat along the run (`step` 1) or the previous one (-1), or null
 * at its end. Disabled seats are passed over unless asked for.
 */
export function stepSeat(
  walk: SeatingWalk,
  seatId: string,
  step: 1 | -1,
  options: SeatStepOptions = {},
): string | null {
  const seat = walk.seats.get(seatId);
  if (!seat) return null;
  const seats = walk.runs[seat.runIndex]!.seats;
  for (
    let position = seat.position + step;
    position >= 0 && position < seats.length;
    position += step
  ) {
    const next = seats[position]!;
    if (options.includeDisabled || !next.disabled) return next.id;
  }
  return null;
}

/**
 * The seat of the next run (`step` 1) or the previous one (-1) nearest to
 * this one, or null when there is no such run. Runs with no seat to stop on
 * are passed over; of two seats as near, the earlier one in the run.
 */
export function jumpRun(
  walk: SeatingWalk,
  points: ReadonlyMap<string, Pick<SeatPoint, "x" | "y">>,
  seatId: string,
  step: 1 | -1,
  options: SeatStepOptions = {},
): string | null {
  const seat = walk.seats.get(seatId);
  const from = points.get(seatId);
  if (!seat || !from) return null;
  for (
    let runIndex = seat.runIndex + step;
    runIndex >= 0 && runIndex < walk.runs.length;
    runIndex += step
  ) {
    let best: { id: string; distance: number } | null = null;
    for (const candidate of walk.runs[runIndex]!.seats) {
      if (candidate.disabled && !options.includeDisabled) continue;
      const point = points.get(candidate.id);
      if (!point) continue;
      const distance = (point.x - from.x) ** 2 + (point.y - from.y) ** 2;
      if (!best || distance < best.distance) {
        best = { id: candidate.id, distance };
      }
    }
    if (best) return best.id;
  }
  return null;
}

// Labels ---------------------------------------------------------------------

/**
 * What a seat is called, in parts the client words through i18n: «Asiento
 * 12, U exterior», «Silla suelta 2», «Fila 3, asiento 4».
 */
export interface SeatLabelParts {
  /** From 1 along its run, disabled seats counted, so numbers never move. */
  number: number;
  run: {
    kind: SeatingRunKind;
    /** From 1 among the runs of its kind ("Fila 2" for the second "other"). */
    ordinal: number;
  };
  /** The seat's own label, if it has one. */
  label: string | null;
  disabled: boolean;
}

export function seatLabelParts(
  walk: SeatingWalk,
  seatId: string,
): SeatLabelParts | null {
  const seat = walk.seats.get(seatId);
  if (!seat) return null;
  const run = walk.runs[seat.runIndex]!;
  const ordinal =
    walk.runs.slice(0, seat.runIndex).filter((other) => other.kind === run.kind)
      .length + 1;
  return {
    number: seat.position + 1,
    run: { kind: run.kind, ordinal },
    label: seat.label,
    disabled: seat.disabled,
  };
}

// Contiguity -----------------------------------------------------------------

/**
 * Splits seats into the pieces that sit together: seats of one run with
 * nothing but disabled seats between them. A loose chair is a piece of its
 * own. Pieces and their seats come in walk order; unknown seats are left
 * out.
 */
export function seatPieces(
  walk: SeatingWalk,
  seatIds: Iterable<string>,
): string[][] {
  const seats = [...new Set(seatIds)]
    .map((id) => walk.seats.get(id))
    .filter((seat): seat is WalkSeat => seat !== undefined)
    .sort(compareWalk);
  const pieces: string[][] = [];
  let previous: WalkSeat | null = null;
  for (const seat of seats) {
    const together =
      previous !== null &&
      previous.runIndex === seat.runIndex &&
      walk.runs[seat.runIndex]!.kind !== "loose" &&
      walk.runs[seat.runIndex]!.seats.slice(
        previous.position + 1,
        seat.position,
      ).every((between) => between.disabled);
    if (together) pieces[pieces.length - 1]!.push(seat.id);
    else pieces.push([seat.id]);
    previous = seat;
  }
  return pieces;
}

import type { SeatAssignment } from "~~/shared/utils/seating/groups";
import {
  enabledSeatIds,
  type SeatingLayout,
} from "~~/shared/utils/seating/layout";
import type { SeatingAssignmentOp } from "~~/shared/utils/seating/proposal";

/**
 * The checks of a seat batch (POST .../seating/assignments) and of a layout
 * save, with no database: the caller locks what they read and writes what
 * they answer. Pure.
 */

export interface AssignmentBatchInput {
  ops: readonly SeatingAssignmentOp[];
  /**
   * The current rows of every seat the batch names and of every seat a
   * `next` person sits on (the rows the caller locked).
   */
  current: readonly SeatAssignment[];
  /** The seats a person may take in the current layout (enabledSeatIds). */
  enabledSeats: ReadonlySet<string>;
  /**
   * The people the batch may seat: those of the plan who need a seat (one
   * marked «No necesita asiento» holds none, and stays out of every count).
   */
  people: ReadonlySet<string>;
}

export interface AssignmentBatchConflict {
  /** The seats that are not as the client saw them, with who sits there now. */
  seats: { seatId: string; personId: string | null }[];
  /** Seats a person was sent to that the layout no longer has or disabled. */
  unavailableSeatIds: string[];
  /**
   * People sent to a seat whom the batch may not seat: the plan no longer
   * has them, or they were marked «No necesita asiento».
   */
  unknownPersonIds: string[];
}

export interface AssignmentBatchWrite {
  /**
   * The rows to delete first: every seat whose occupant changes and that
   * the client saw occupied, with that occupant. Never a seat the client
   * saw empty: its row (if another batch filled it meanwhile) was never
   * locked nor compared, so deleting it would throw that batch's person
   * out unseen. Inserting over it fails instead (a unique violation, 409).
   */
  deletes: SeatAssignment[];
  /** Then the new occupants. */
  inserts: SeatAssignment[];
  /** Seated where they had no seat. */
  placed: number;
  /** From one seat to another. */
  moved: number;
  /** Left without a seat. */
  removed: number;
  /** Everyone whose seat changes. */
  personIds: string[];
}

export type AssignmentBatchCheck =
  | { ok: true; write: AssignmentBatchWrite }
  | { ok: false; conflict: AssignmentBatchConflict };

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Checks a batch against the current state:
 * - each seat must hold who the client saw (`expected`, null for empty);
 * - a `next` person who sits on a seat the batch does not name would sit
 *   twice: that seat is a conflict too (a batch moves someone only by
 *   emptying their seat in the same batch, as assignmentOps does);
 * - a seat that takes someone must exist and not be disabled; the person
 *   must be of the plan. Emptying a seat is always allowed.
 * All or none: any problem answers the conflict and writes nothing.
 */
export function checkAssignmentBatch(
  input: AssignmentBatchInput,
): AssignmentBatchCheck {
  const occupantOf = new Map(
    input.current.map((row) => [row.seatId, row.personId]),
  );
  const seatOf = new Map(
    input.current.map((row) => [row.personId, row.seatId]),
  );
  const named = new Set(input.ops.map((op) => op.seatId));

  const conflicts = new Map<string, string | null>();
  const unavailable = new Set<string>();
  const unknown = new Set<string>();
  for (const op of input.ops) {
    const current = occupantOf.get(op.seatId) ?? null;
    if (current !== op.expected) conflicts.set(op.seatId, current);
    if (op.next === null) continue;
    if (!input.enabledSeats.has(op.seatId)) unavailable.add(op.seatId);
    if (!input.people.has(op.next)) unknown.add(op.next);
    const seat = seatOf.get(op.next);
    if (seat && seat !== op.seatId && !named.has(seat)) {
      conflicts.set(seat, op.next);
    }
  }
  if (conflicts.size > 0 || unavailable.size > 0 || unknown.size > 0) {
    return {
      ok: false,
      conflict: {
        seats: [...conflicts]
          .sort(([a], [b]) => byId(a, b))
          .map(([seatId, personId]) => ({ seatId, personId })),
        unavailableSeatIds: [...unavailable].sort(byId),
        unknownPersonIds: [...unknown].sort(byId),
      },
    };
  }

  const effective = input.ops.filter((op) => op.next !== op.expected);
  const after = new Map<string, string>();
  for (const op of effective) if (op.next) after.set(op.next, op.seatId);
  const before = new Map<string, string>();
  for (const op of effective) {
    if (op.expected) before.set(op.expected, op.seatId);
  }
  // Someone placed by the batch may already sit on a seat it empties.
  for (const personId of after.keys()) {
    const seat = seatOf.get(personId);
    if (seat) before.set(personId, seat);
  }

  let placed = 0;
  let moved = 0;
  let removed = 0;
  const personIds = new Set<string>();
  for (const [personId, seat] of after) {
    const previous = before.get(personId);
    if (previous === undefined) placed += 1;
    else if (previous !== seat) moved += 1;
    else continue;
    personIds.add(personId);
  }
  for (const personId of before.keys()) {
    if (after.has(personId)) continue;
    removed += 1;
    personIds.add(personId);
  }

  return {
    ok: true,
    write: {
      deletes: effective
        .flatMap((op) =>
          op.expected ? [{ seatId: op.seatId, personId: op.expected }] : [],
        )
        .sort((a, b) => byId(a.seatId, b.seatId)),
      inserts: effective
        .flatMap((op) =>
          op.next ? [{ seatId: op.seatId, personId: op.next }] : [],
        )
        .sort((a, b) => byId(a.seatId, b.seatId)),
      placed,
      moved,
      removed,
      personIds: [...personIds].sort(byId),
    },
  };
}

/**
 * The assignments a new layout leaves without a seat: on seats it does not
 * have or disables. A layout save that would leave any is refused unless the
 * request confirms them (`releaseSeats`, releaseConfirmed), and then they go
 * back to the tray.
 */
export function assignmentsLostByLayout(
  next: SeatingLayout,
  assignments: readonly SeatAssignment[],
): SeatAssignment[] {
  const kept = enabledSeatIds(next);
  return assignments
    .filter((row) => !kept.has(row.seatId))
    .sort((a, b) => byId(a.seatId, b.seatId));
}

/**
 * Whether a layout save may send `lost` back to the tray: the request
 * confirmed every one of them, the seat and who sits on it, as the 409
 * `seating_seats_occupied` showed them. Someone seated on those seats since
 * then was never shown, so the save is refused again with the new list
 * (the precedent of isDeactivationConfirmed: a confirmation never stretches
 * beyond what was shown).
 */
export function releaseConfirmed(
  lost: readonly SeatAssignment[],
  confirmed: readonly SeatAssignment[] | undefined,
): boolean {
  if (lost.length === 0) return true;
  if (!confirmed) return false;
  const shown = new Set(
    confirmed.map((row) => `${row.seatId}/${row.personId}`),
  );
  return lost.every((row) => shown.has(`${row.seatId}/${row.personId}`));
}

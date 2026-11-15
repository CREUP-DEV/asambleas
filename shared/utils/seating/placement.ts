import type { SeatingWalk } from "./runs";

/**
 * Placing N people from one seat (docs/seating-plan.md, section 7,
 * «Colocar»): the seats an account of N would take when dropped or tapped on
 * a seat, which the page lights up before it places them.
 */

export interface BlockSeatsOptions {
  /** Seats someone holds now. */
  occupied?: ReadonlySet<string>;
  /**
   * Pass over occupied seats, as placing from the tray does. Without it they
   * count as any other seat (moving a block onto others, which asks first).
   */
  skipOccupied?: boolean;
}

export interface BlockSeats {
  /** In walk order. Fewer than N when they do not fit. */
  seatIds: string[];
  /** Whether all N have a seat. */
  fits: boolean;
}

/**
 * The seats N people take from `targetSeatId`: forwards along its run from
 * that seat; when the run ends first, the window of N that ends with the run
 * (so it still holds the target); when the whole run has fewer, every seat
 * it has. Disabled seats are always passed over. A loose chair takes one
 * person only.
 */
export function blockSeats(
  walk: SeatingWalk,
  targetSeatId: string,
  count: number,
  options: BlockSeatsOptions = {},
): BlockSeats {
  const target = walk.seats.get(targetSeatId);
  if (!target || target.disabled || count < 1) {
    return { seatIds: [], fits: false };
  }
  const occupied = options.occupied ?? new Set<string>();
  const usable = (id: string) => !(options.skipOccupied && occupied.has(id));
  const run = walk.runs[target.runIndex]!;
  if (run.kind === "loose") {
    return usable(target.id)
      ? { seatIds: [target.id], fits: count === 1 }
      : { seatIds: [], fits: false };
  }
  const candidates = run.seats.filter(
    (seat) => !seat.disabled && usable(seat.id),
  );
  let start = candidates.findIndex((seat) => seat.position >= target.position);
  if (start === -1) start = candidates.length;
  if (start + count <= candidates.length) {
    return {
      seatIds: candidates.slice(start, start + count).map((seat) => seat.id),
      fits: true,
    };
  }
  if (candidates.length >= count) {
    return {
      seatIds: candidates.slice(-count).map((seat) => seat.id),
      fits: true,
    };
  }
  return { seatIds: candidates.map((seat) => seat.id), fits: false };
}

import { sessionFormatDuration } from "~/composables/session/sessionModel";

/**
 * What the clock of a turn with the floor shows. Without a limit, the time
 * spoken ("2:31"). With one, the time left ("0:42"), and past it the time
 * over, signed ("+0:12") and `overtime`, so the clock can say so with more
 * than its colour.
 */
export interface TurnClock {
  text: string;
  overtime: boolean;
  /** Seconds left; negative past the limit, null without one. */
  remaining: number | null;
}

export function turnClock(
  elapsedSeconds: number,
  limitSeconds: number | null | undefined,
): TurnClock {
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  if (!limitSeconds || limitSeconds <= 0) {
    return {
      text: sessionFormatDuration(elapsed),
      overtime: false,
      remaining: null,
    };
  }
  const remaining = limitSeconds - elapsed;
  if (remaining >= 0) {
    return {
      text: sessionFormatDuration(remaining),
      overtime: false,
      remaining,
    };
  }
  return {
    text: `+${sessionFormatDuration(-remaining)}`,
    overtime: true,
    remaining,
  };
}

/**
 * The widest text the clock of a turn takes (its digits all "0"), for a
 * slot that must not change width while the turn lasts (the projection;
 * every digit takes a cell of the same width, CommonTabularDigits). With a
 * limit, the limit's shape signed, which covers the countdown and the time
 * over until it reaches the limit again ("+0:00" for 3 minutes); without
 * one, minutes in two digits ("00:00"), which covers the first hour.
 */
export function turnClockReserve(
  limitSeconds: number | null | undefined,
): string {
  if (!limitSeconds || limitSeconds <= 0) return "00:00";
  return `+${sessionFormatDuration(limitSeconds).replace(/\d/g, "0")}`;
}

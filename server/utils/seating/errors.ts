import { createError } from "h3";
import type { H3Event } from "h3";
import { logError } from "../core/logger";
import { isUniqueConstraintViolation } from "../errors";

/**
 * The error funnel of the seating handlers, in place of throwMutationError.
 * A failed query reaches here wrapped by drizzle, whose message and stack
 * end with the query's parameters: the names of the attendees a sync or a
 * person's write was storing. Attendee names never go to a log
 * (docs/seating-plan.md, section 1), so only the error's name and its
 * Postgres code are logged, never the error itself.
 */

/** A Postgres error code (SQLSTATE), through drizzle's wrapping. */
export function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object") return null;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** What a seating error leaves in the log: its name and SQLSTATE only. */
export function seatingErrorSummary(error: unknown): {
  name: string;
  pgCode: string | null;
} {
  // drizzle's DrizzleQueryError keeps the name "Error": its class says more.
  const name =
    error instanceof Error
      ? error.name === "Error" && error.constructor.name
        ? error.constructor.name
        : error.name
      : typeof error;
  return { name, pgCode: pgErrorCode(error) };
}

/**
 * Rethrows an HTTP error as it is, turns a unique violation into the usual
 * 409, and answers anything else with a generic 500 after logging only its
 * summary.
 */
export function throwSeatingError(
  scope: string,
  error: unknown,
  event?: H3Event,
): never {
  if (error && typeof error === "object" && "statusCode" in error) {
    throw error;
  }
  if (isUniqueConstraintViolation(error)) {
    throw createError({
      statusCode: 409,
      message: "Ya existe un registro con esos datos",
    });
  }
  logError(scope, seatingErrorSummary(error), undefined, event);
  throw createError({
    statusCode: 500,
    message: "Error al procesar la solicitud",
  });
}

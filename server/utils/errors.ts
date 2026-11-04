import { createError } from "h3";
import type { H3Event } from "h3";
import { logError } from "./core/logger";

/**
 * True for a Postgres unique violation, also when drizzle wraps the driver
 * error in a DrizzleQueryError and keeps it in `cause`.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function throwMutationError(
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

  logError(scope, error, undefined, event);

  throw createError({
    statusCode: 500,
    message: "Error al procesar la solicitud",
  });
}

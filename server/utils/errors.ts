import { createError } from "h3";
import type { H3Event } from "h3";
import { logError } from "./core/logger";

export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
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

import { createError } from "h3";
import {
  ENTITY_ID_PATTERN,
  USER_ID_PATTERN,
} from "~~/shared/utils/schemas/primitives";

/**
 * Route params of handlers without a resolver: a malformed id answers 400.
 * A param that names something the actor may not see goes through its
 * resolver instead (`server/utils/domain/resolvers.ts`), which answers 404.
 * Both read the patterns of `shared/utils/schemas/primitives.ts`.
 */

/** A domain row's id (ENTITY_ID_PATTERN), or 400. */
export function validateCuid(id: string | undefined, label = "ID"): string {
  if (!id || !ENTITY_ID_PATTERN.test(id)) {
    throw createError({ statusCode: 400, message: `${label} inválido` });
  }
  return id;
}

/** An account's id (USER_ID_PATTERN), or 400. */
export function validateAuthId(id: string | undefined, label = "ID"): string {
  if (!id || !USER_ID_PATTERN.test(id)) {
    throw createError({ statusCode: 400, message: `${label} inválido` });
  }
  return id;
}

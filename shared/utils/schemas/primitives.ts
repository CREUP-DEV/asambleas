import { z } from "zod/v4";

/**
 * The one definition of each primitive the API validates (ARQ-31): ids of
 * domain rows, account ids and ISO instants. Schemas, resolvers and route
 * checks import them from here, never a copy of their own. This module
 * imports only zod, so `shared/types` and client code may use it too.
 */

/**
 * An id of a domain row, unanchored, for patterns that embed one
 * (`item:<id>`, `logo-<id>-<version>.webp`).
 */
export const ENTITY_ID_SOURCE = "[a-z0-9]{20,32}";

/**
 * Ids of domain rows: what `cuid()` generates (24 characters) and the fixed
 * ids that are not cuid2, such as GENERIC_EXECUTIVE_MEMBER_ID (25).
 */
export const ENTITY_ID_PATTERN = new RegExp(`^${ENTITY_ID_SOURCE}$`);

export const entityIdSchema = z.string().regex(ENTITY_ID_PATTERN);

/** Whether a route param or a value is shaped like a domain row's id. */
export function isEntityId(value: string | null | undefined): value is string {
  return typeof value === "string" && ENTITY_ID_PATTERN.test(value);
}

/**
 * Account ids (`users.id`), unanchored: better-auth's default `generateId`,
 * 32 letters and digits.
 */
export const USER_ID_SOURCE = "[a-zA-Z0-9]{32}";

export const USER_ID_PATTERN = new RegExp(`^${USER_ID_SOURCE}$`);

export const userIdSchema = z.string().regex(USER_ID_PATTERN);

/**
 * An ISO 8601 date-time with its offset that Postgres can cast
 * (`::timestamptz`): the format alone lets year 0000 through, which
 * Postgres refuses.
 */
export const isoInstantSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Number(value.slice(0, 4)) >= 1, {
    message: "Fecha fuera de rango",
  });

/** The `updatedAt` a client echoes back for optimistic locking. */
export const updatedAtSchema = isoInstantSchema;

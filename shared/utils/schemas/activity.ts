import { z } from "zod/v4";
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_KINDS,
  ACTIVITY_PAGE_DEFAULT_LIMIT,
  ADMIN_ACTIVITY_MAX_LIMIT,
  AUDIT_SOURCES,
  IMPERSONATION_REASON_MAX_LENGTH,
  ME_ACTIVITY_MAX_LIMIT,
  ME_ACTIVITY_TABS,
} from "../../constants/activity";
import type {
  ActivityCursor,
  AdminActivityQuery,
  AdminImpersonationQuery,
  ImpersonationStartBody,
  MeActivityQuery,
} from "../../types/api";
import { normalizeText } from "./content";

/**
 * Bodies and queries of impersonation and the activity lists (docs/api.md,
 * "Activity and impersonation"). Queries arrive as h3 getQuery values: a
 * repeated parameter is an array, everything else a string.
 */

/** better-auth user ids (users.id): 32 letters and digits. */
export const USER_ID_PATTERN = /^[a-zA-Z0-9]{32}$/;
/** cuid2 ids of the domain rows (members, impersonations, events...). */
const ENTITY_ID_PATTERN = /^[a-z0-9]{20,32}$/;
/** An assembly slug ("80-ago") or id. */
const ASSEMBLY_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Cursor times: UTC ISO 8601 with up to microseconds. */
const CURSOR_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export const ACTIVITY_SEARCH_MAX_LENGTH = 100;
/** Most values one list filter takes. */
export const ACTIVITY_FILTER_MAX_VALUES = 50;

const userId = z.string().regex(USER_ID_PATTERN);
const entityId = z.string().regex(ENTITY_ID_PATTERN);
const assemblyRef = z.string().regex(ASSEMBLY_REF_PATTERN);
/**
 * An ISO date-time Postgres can cast (`::timestamptz`): the format alone
 * lets year 0000 through, which Postgres refuses.
 */
const isoDateTime = z.iso
  .datetime({ offset: true })
  .refine((value) => Number(value.slice(0, 4)) >= 1, {
    message: "Fecha fuera de rango",
  });

// Cursor -------------------------------------------------------------------

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
}

/**
 * The opaque `nextCursor` of an activity page: the last item's database
 * time (with microseconds, as text) and id. Build `at` in SQL, never from a
 * JS Date: to_char(created_at at time zone 'UTC',
 * 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"').
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return toBase64Url(JSON.stringify([cursor.at, cursor.id]));
}

/**
 * A cursor time that names a real instant Postgres accepts: the pattern
 * checks only the shape, so 02-30, 25:00 or year 0000 are refused here by a
 * round trip through Date (cursors are always UTC with "Z").
 */
function isCursorTime(at: string): boolean {
  if (!CURSOR_AT_PATTERN.test(at)) return false;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return false;
  const year = date.getUTCFullYear();
  return (
    year >= 1 &&
    year <= 9999 &&
    date.toISOString().slice(0, 19) === at.slice(0, 19)
  );
}

/** The position in a cursor, or null when it is not one this API issued. */
export function decodeActivityCursor(value: string): ActivityCursor | null {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(value));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      isCursorTime(parsed[0]) &&
      ENTITY_ID_PATTERN.test(parsed[1])
    ) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // Not base64 or not JSON: not a cursor.
  }
  return null;
}

/** `cursor` query parameter: decoded, or a validation error. */
export const activityCursorSchema = z
  .string()
  .transform((value, ctx): ActivityCursor => {
    const cursor = decodeActivityCursor(value);
    if (!cursor) {
      ctx.addIssue({ code: "custom", message: "Cursor inválido" });
      return z.NEVER;
    }
    return cursor;
  });

// Query helpers ------------------------------------------------------------

/**
 * A list filter: a repeated parameter or comma-separated values, trimmed,
 * without duplicates. Missing or empty is undefined.
 */
function listParam<T extends z.ZodType>(item: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap((part) => String(part).split(","))
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return parts.length > 0 ? [...new Set(parts)] : undefined;
  }, z.array(item).max(ACTIVITY_FILTER_MAX_VALUES).optional());
}

/** "1"/"true" or "0"/"false"; missing is undefined. */
const booleanParam = z
  .enum(["1", "0", "true", "false"])
  .optional()
  .transform((value) =>
    value === undefined ? undefined : value === "1" || value === "true",
  );

const limitParam = (max: number) =>
  z.coerce.number().int().min(1).max(max).default(ACTIVITY_PAGE_DEFAULT_LIMIT);

const searchParam = z
  .string()
  .max(ACTIVITY_SEARCH_MAX_LENGTH * 2)
  .transform((value) => {
    const text = normalizeText(value).replace(/\s+/g, " ").trim();
    return text === "" ? undefined : text;
  })
  .pipe(z.string().max(ACTIVITY_SEARCH_MAX_LENGTH).optional())
  .optional();

const fromBeforeTo = (query: { from?: string; to?: string }) =>
  !query.from || !query.to || new Date(query.from) < new Date(query.to);
const fromBeforeToIssue = {
  message: "La fecha de inicio debe ser anterior a la de fin",
  path: ["to"],
};

// Impersonation ------------------------------------------------------------

/** POST /api/admin/users/[id]/impersonate. */
export const impersonationStartBodySchema = z.object({
  reason: z
    .string()
    .max(IMPERSONATION_REASON_MAX_LENGTH * 4)
    .transform((value) => normalizeText(value).replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(IMPERSONATION_REASON_MAX_LENGTH)),
});

/** GET /api/admin/impersonations. */
export const adminImpersonationQuerySchema = z.object({
  admin: userId.optional(),
  target: userId.optional(),
  active: booleanParam,
  cursor: activityCursorSchema.optional(),
  limit: limitParam(ADMIN_ACTIVITY_MAX_LIMIT),
});

// Activity -----------------------------------------------------------------

/** GET /api/me/activity. */
export const meActivityQuerySchema = z
  .object({
    tab: z.enum(ME_ACTIVITY_TABS).default("by"),
    assembly: assemblyRef.optional(),
    category: listParam(z.enum(ACTIVITY_CATEGORIES)),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    cursor: activityCursorSchema.optional(),
    limit: limitParam(ME_ACTIVITY_MAX_LIMIT),
  })
  .refine(fromBeforeTo, fromBeforeToIssue);

/** GET /api/admin/activity (Admin only). */
export const adminActivityQuerySchema = z
  .object({
    actor: userId.optional(),
    target: userId.optional(),
    user: userId.optional(),
    member: entityId.optional(),
    assembly: assemblyRef.optional(),
    action: listParam(z.string().regex(/^[a-z][a-z_.]{0,63}$/)),
    category: listParam(z.enum(ACTIVITY_CATEGORIES)),
    kind: listParam(z.enum(ACTIVITY_KINDS)),
    source: listParam(z.enum(AUDIT_SOURCES)),
    impersonated: booleanParam,
    impersonation: entityId.optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    q: searchParam,
    cursor: activityCursorSchema.optional(),
    limit: limitParam(ADMIN_ACTIVITY_MAX_LIMIT),
  })
  .refine(fromBeforeTo, fromBeforeToIssue);

// Compile-time checks: every parsed body or query is assignable to its API type.
type Assignable<T, U extends T> = U;
export type _ActivitySchemaChecks = [
  Assignable<
    ImpersonationStartBody,
    z.output<typeof impersonationStartBodySchema>
  >,
  Assignable<
    AdminImpersonationQuery,
    z.output<typeof adminImpersonationQuerySchema>
  >,
  Assignable<MeActivityQuery, z.output<typeof meActivityQuerySchema>>,
  Assignable<AdminActivityQuery, z.output<typeof adminActivityQuerySchema>>,
];

import type { H3Error, H3Event } from "h3";
import { logError } from "./core/logger";
import { fail } from "./core/http";

/**
 * The funnel of unexpected errors in a mutation (ARQ-4). A failed query
 * reaches it wrapped by drizzle, whose message and stack end with the
 * query's parameters: notes, justifications, amendment texts, attendees'
 * names. So it never logs the error itself, only its summary
 * (`errorSummary`): the error's class, its Postgres code and constraint, and
 * the stack's frames without the message.
 */

type PgLike = { code?: unknown; constraint?: unknown; cause?: unknown };

/** The error and its `cause` chain (drizzle's wrapping), up to 5 levels. */
function causeChain(error: unknown): PgLike[] {
  const chain: PgLike[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object") break;
    chain.push(current as PgLike);
    current = (current as PgLike).cause;
  }
  return chain;
}

/** The first Postgres error (one with a SQLSTATE) in the chain, or null. */
function pgError(
  error: unknown,
): { code: string; constraint?: unknown } | null {
  const found = causeChain(error).find(
    (level) =>
      typeof level.code === "string" && /^[0-9A-Z]{5}$/.test(level.code),
  );
  return (found as { code: string; constraint?: unknown } | undefined) ?? null;
}

/** A Postgres error code (SQLSTATE), through drizzle's wrapping. */
export function pgErrorCode(error: unknown): string | null {
  return pgError(error)?.code ?? null;
}

/**
 * True for a Postgres unique violation, also when drizzle wraps the driver
 * error in a DrizzleQueryError and keeps it in `cause`.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return causeChain(error).some((level) => level.code === "23505");
}

const MAX_FRAMES = 8;

/**
 * What an unexpected error leaves in the log: its name (drizzle's
 * DrizzleQueryError keeps the name "Error": its class says more), its
 * SQLSTATE and constraint, and where it was thrown, never its message,
 * which may carry the query's parameters.
 */
export function errorSummary(error: unknown): {
  name: string;
  pgCode: string | null;
  constraint?: string;
  frames?: string[];
} {
  const name =
    error instanceof Error
      ? error.name === "Error" && error.constructor.name
        ? error.constructor.name
        : error.name
      : typeof error;
  const pg = pgError(error);
  const frames = stackFrames(error);
  return {
    name,
    pgCode: pg?.code ?? null,
    ...(typeof pg?.constraint === "string"
      ? { constraint: pg.constraint }
      : {}),
    ...(frames.length > 0 ? { frames } : {}),
  };
}

/** The stack's frames, after the message (which a value could fake). */
function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const at = error.message ? error.stack.indexOf(error.message) : -1;
  const rest =
    at >= 0 ? error.stack.slice(at + error.message.length) : error.stack;
  return rest
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim());
}

/**
 * Rethrows an HTTP error as it is, turns a unique violation into the usual
 * 409, and answers anything else with a generic 500 after logging only its
 * summary.
 */
export function throwMutationError(
  scope: string,
  error: unknown,
  event?: H3Event,
): never {
  if (error && typeof error === "object" && "statusCode" in error) {
    throw error;
  }

  if (isUniqueConstraintViolation(error)) {
    fail(409, "Ya existe un registro con esos datos");
  }

  logError(scope, errorSummary(error), undefined, event);

  fail(500, "Error al procesar la solicitud");
}

/** Whether a request is one of the API's (`/api/...`). */
function isApiPath(path: string | undefined): boolean {
  return typeof path === "string" && /^\/api(?:\/|\?|$)/.test(path);
}

/**
 * The funnel of the errors no handler caught (`server/plugins/error-funnel.ts`
 * runs it before Nitro's and Nuxt's error handlers): on an API request, h3
 * wraps the thrown value in an H3Error marked `unhandled`, whose message and
 * stack are the drizzle error's, query parameters included, and Nitro's and
 * Nuxt's handlers would log it whole. So it turns the error, in place, into
 * what `throwMutationError` answers: a unique violation into the usual 409,
 * anything else into «Error al procesar la solicitud» after logging only its
 * summary, with the status h3 gave it (500, or the thrown value's own
 * `statusCode` or `status`, such as an Intranet call's). An HTTP error (`fail`, `createError`) is not `unhandled`
 * and passes untouched, and so does any error outside the API (a page's,
 * which Nuxt's error page shows).
 */
export function funnelUnhandledError(error: H3Error, event: H3Event): void {
  if (!error.unhandled || !isApiPath(event.path)) return;
  if (isUniqueConstraintViolation(error)) {
    answerInstead(error, 409, "Ya existe un registro con esos datos");
    return;
  }
  // h3 keeps the thrown error's `cause` (the driver's error for a query) or
  // the error itself as the wrapper's cause: its class names what failed.
  const cause = error.cause ?? error;
  logError(
    "unhandled",
    { ...errorSummary(error), name: errorSummary(cause).name },
    undefined,
    event,
  );
  answerInstead(error, error.statusCode, "Error al procesar la solicitud");
}

/**
 * Rewrites an unhandled H3Error into a handled one with its own text: no
 * longer `unhandled`, so Nitro, Nuxt and h3 log nothing and send `message`,
 * which no longer carries the original's.
 */
function answerInstead(
  error: H3Error,
  statusCode: number,
  message: string,
): void {
  error.statusCode = statusCode;
  error.statusMessage = undefined;
  error.message = message;
  error.data = undefined;
  error.unhandled = false;
}

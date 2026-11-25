import type { H3Event } from "h3";
import { createError, getQuery, readBody } from "h3";
import type { z } from "zod/v4";

/**
 * The one way a server module refuses a request and reads what it sent
 * (ARQ-4): every domain module and handler throws through `fail` and
 * `notFound` and reads its body through `readBodyWith`, never a private copy
 * (`http.test.ts` fails a new `function fail(` in `server/utils/domain`).
 */

/**
 * Throws an HTTP error with its extra fields (`messageKey`, `reason`…). h3
 * keeps `data` only when it is truthy, so a missing one sends none.
 */
export function fail(
  statusCode: number,
  message: string,
  data?: unknown,
): never {
  throw createError({ statusCode, message, ...(data ? { data } : {}) });
}

/** Throws a 404: what a reader may not see answers like what is not there. */
export function notFound(message: string, data?: unknown): never {
  fail(404, message, data);
}

/** The 400 of a body or value that fails its schema. */
export const INVALID_DATA_MESSAGE = "Datos no válidos";
/** The 400 of a body that is not JSON. */
export const INVALID_BODY_MESSAGE = "Cuerpo de la petición no válido";
/** The 400 of a query string that fails its schema. */
export const INVALID_QUERY_MESSAGE = "Parámetros no válidos";

/** How a refusal of a value that fails its schema reads. */
export interface ParseOptions {
  /**
   * The 400's own text, in place of "Datos no válidos" with the issues: the
   * refusal then carries `data` and nothing else.
   */
  message?: string;
  /** Extra fields of that refusal, such as `messageKey`. */
  data?: unknown;
}

/**
 * Validates a value already read (a body, a query) with a Zod schema,
 * answering 400 on failure: "Datos no válidos" with each issue's path and
 * message, or the caller's own text.
 */
export function parseWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  options: ParseOptions = {},
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (options.message !== undefined) fail(400, options.message, options.data);
  fail(400, INVALID_DATA_MESSAGE, {
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export interface ReadBodyOptions extends ParseOptions {
  /**
   * What a request with no body (or a JSON `null`) reads as, such as `{}`
   * for an endpoint whose fields are all optional. Without it the schema
   * sees `undefined`.
   */
  empty?: unknown;
}

/**
 * Reads and validates a JSON body: a body that is not JSON answers 400
 * "Cuerpo de la petición no válido", one that fails the schema as
 * `parseWith` says.
 */
export async function readBodyWith<S extends z.ZodType>(
  event: H3Event,
  schema: S,
  options: ReadBodyOptions = {},
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await readBody(event);
  } catch {
    fail(400, INVALID_BODY_MESSAGE);
  }
  if (raw == null && "empty" in options) raw = options.empty;
  return parseWith(schema, raw, options);
}

/**
 * Validates the query string, answering 400 "Parámetros no válidos" (or the
 * caller's own text) on failure, without issues.
 */
export function readQueryWith<S extends z.ZodType>(
  event: H3Event,
  schema: S,
  options: ParseOptions = {},
): z.output<S> {
  const parsed = schema.safeParse(getQuery(event));
  if (!parsed.success) {
    fail(400, options.message ?? INVALID_QUERY_MESSAGE, options.data);
  }
  return parsed.data;
}

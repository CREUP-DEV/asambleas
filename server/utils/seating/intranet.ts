import { z } from "zod/v4";
import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import {
  intranetAttendeesResponseSchema,
  type IntranetAttendeesResponse,
} from "~~/shared/utils/schemas/seating";
import { logWarn } from "../core/logger";
import {
  INTRANET_TIMEOUT_MS,
  IntranetUnavailableError,
  getIntranetApiBaseUrl,
  intranetAuthHeaders,
  intranetUrl,
} from "../members/intranet";

/**
 * The Intranet's routes of the seating view (docs/intranet.md, «Rutas de la
 * vista de la sala»), on the private group of NUXT_INTRANET_API_URL, with
 * its token (intranetAuthHeaders) and isIntranetUrlAllowed through
 * getIntranetApiBaseUrl:
 *
 * - `GET {base}/asambleas/{type}/{number}/asistentes`: the accounts and
 *   attendees of the event that carries the assembly's type and number;
 * - `GET {base}/cuentas/{user}/logo` and `GET {base}/asistentes/{id}/foto`:
 *   the images, fetched by the seating-images queue, never by a browser.
 *
 * These routes carry personal data (names and photos): logs say how a call
 * went and how many rows came, never a name, nor the issues of a payload
 * that did not parse.
 */

/** The attendees list, capped well above 5000 rows of each kind. */
export const SEATING_ATTENDEES_MAX_BYTES = 8 * 1024 * 1024;
/** An image as the Intranet serves it (its own limit is 5 MB). */
export const SEATING_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** The exact body of the private group's 404 for a pair without event. */
const notFoundBodySchema = z.strictObject({ error: z.literal("not_found") });

export type SeatingAttendeesFailure =
  | "network"
  | "timeout"
  | "status"
  | "too_large"
  | "invalid_json"
  | "invalid_payload";

/**
 * How reading the attendees went:
 * - `ok`: the list, parsed (intranetAttendeesResponseSchema);
 * - `notFound`: no Intranet event carries this type and number: a 404 with
 *   exactly `{"error":"not_found"}`, not redirected;
 * - `unavailable`: any other 404, which is the Intranet without the route
 *   (Laravel's own 404 body): the plan goes on with groups made by hand;
 * - `failed`: a timeout, a network error, any other status (401, 429, 5xx),
 *   an answer too large or one that does not parse;
 * - `unconfigured`: no usable NUXT_INTRANET_API_URL.
 */
export type SeatingAttendeesFetch =
  | { outcome: "ok"; data: IntranetAttendeesResponse }
  | { outcome: "notFound" }
  | { outcome: "unavailable"; status: number }
  | {
      outcome: "failed";
      reason: SeatingAttendeesFailure;
      status: number | null;
    }
  | { outcome: "unconfigured" };

/** The path of an assembly's attendees: `asambleas/AGO/80/asistentes`. */
export function attendeesPath(type: AssemblyType, number: number): string {
  return `asambleas/${type.toUpperCase()}/${String(number)}/asistentes`;
}

const TOO_LARGE = Symbol("too large");

/**
 * The body of a response, read as a stream and given up past `maxBytes`
 * (a declared Content-Length above it is refused before reading).
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer | typeof TOO_LARGE> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return TOO_LARGE;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function isTooLarge(value: unknown): value is typeof TOO_LARGE {
  return value === TOO_LARGE;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Reads the attendees of the Intranet event of an assembly (type and
 * number, never its name). Never throws; every outcome but `ok` and
 * `unconfigured` is logged here (scope `seating.intranet`), with counts and
 * statuses only.
 */
export async function fetchAssemblyAttendees(
  type: AssemblyType,
  number: number,
): Promise<SeatingAttendeesFetch> {
  const base = getIntranetApiBaseUrl();
  if (!base) return { outcome: "unconfigured" };
  const fail = (
    reason: SeatingAttendeesFailure,
    status: number | null,
  ): SeatingAttendeesFetch => {
    logWarn("seating.intranet", { outcome: "failed", reason, status });
    return { outcome: "failed", reason, status };
  };

  let response: Response;
  try {
    response = await fetch(intranetUrl(base, attendeesPath(type, number)), {
      headers: { Accept: "application/json", ...intranetAuthHeaders() },
      signal: AbortSignal.timeout(INTRANET_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return fail(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      null,
    );
  }

  let body: Buffer | typeof TOO_LARGE;
  try {
    body = await readCapped(response, SEATING_ATTENDEES_MAX_BYTES);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return fail(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      response.status,
    );
  }
  if (isTooLarge(body)) return fail("too_large", response.status);

  if (response.status === 404) {
    if (
      !response.redirected &&
      notFoundBodySchema.safeParse(parseJson(body)).success
    ) {
      logWarn("seating.intranet", { outcome: "not_found" });
      return { outcome: "notFound" };
    }
    // The Intranet without the route answers its own 404 page.
    logWarn("seating.intranet", { outcome: "unavailable", status: 404 });
    return { outcome: "unavailable", status: 404 };
  }
  if (!response.ok) return fail("status", response.status);

  const payload = parseJson(body);
  if (payload === undefined) return fail("invalid_json", response.status);
  const parsed = intranetAttendeesResponseSchema.safeParse(payload);
  // Never the issues: they would quote the rows, names included.
  if (!parsed.success) return fail("invalid_payload", response.status);
  return { outcome: "ok", data: parsed.data };
}

// Images ---------------------------------------------------------------------

export type SeatingImageKind = "logo" | "photo";

/** `cuentas/412/logo` or `asistentes/5120/foto`. */
export function imagePath(kind: SeatingImageKind, intranetId: number): string {
  return kind === "logo"
    ? `cuentas/${String(intranetId)}/logo`
    : `asistentes/${String(intranetId)}/foto`;
}

/**
 * How fetching one image went: its bytes, or `missing` when the Intranet
 * does not serve it (404: removed, never a real image) or it is larger than
 * SEATING_IMAGE_MAX_BYTES, which no retry changes.
 */
export type SeatingImageFetch =
  | { outcome: "ok"; data: Buffer }
  | { outcome: "missing"; reason: "not_found" | "too_large" };

/**
 * Fetches an image of the seating view from the Intranet, with the token.
 * Throws IntranetUnavailableError on what a retry may mend (no URL, network,
 * timeout, any status but 404), so the queue tries again.
 */
export async function fetchSeatingImage(
  kind: SeatingImageKind,
  intranetId: number,
): Promise<SeatingImageFetch> {
  const path = imagePath(kind, intranetId);
  const base = getIntranetApiBaseUrl();
  if (!base) throw new IntranetUnavailableError(path, "unconfigured");
  let response: Response;
  try {
    response = await fetch(intranetUrl(base, path), {
      headers: { Accept: "image/*", ...intranetAuthHeaders() },
      signal: AbortSignal.timeout(INTRANET_TIMEOUT_MS),
    });
  } catch (error) {
    throw new IntranetUnavailableError(
      path,
      error instanceof Error ? error.name : "network",
    );
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { outcome: "missing", reason: "not_found" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new IntranetUnavailableError(path, `status ${response.status}`);
  }
  let data: Buffer | typeof TOO_LARGE;
  try {
    data = await readCapped(response, SEATING_IMAGE_MAX_BYTES);
  } catch (error) {
    throw new IntranetUnavailableError(
      path,
      error instanceof Error ? error.name : "network",
    );
  }
  if (isTooLarge(data)) return { outcome: "missing", reason: "too_large" };
  return { outcome: "ok", data };
}

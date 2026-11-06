import { createHmac } from "node:crypto";
import { z } from "zod/v4";
import { intranetIdSchema } from "~~/shared/utils/schemas/member";
import { logError, logWarn } from "../core/logger";
import {
  intranetRosterResponseSchema,
  type IntranetRosterEntry,
  type RosterKind,
} from "./roster";

/**
 * Client for the CREUP intranet API (docs/intranet.md, section 4.3; the
 * private group is `/api/asambleas/v1`):
 * - `GET {base}/usuarios/asociados` and `GET {base}/usuarios/sectoriales`
 *   return `{ data: [...], generated_at }`;
 * - `POST {base}/user/role` returns `{ id, role, name, initials, university }`
 *   for an email, or 404 `{"error":"not_found"}` when the intranet has no
 *   such account (lookupIntranetRole).
 * Every request sends `Accept: application/json` and the API token when one
 * is configured (intranetAuthHeaders). In production only `https:` URLs are
 * used, or `http:` toward an internal host with no dot (isIntranetUrlAllowed).
 */

export const INTRANET_TIMEOUT_MS = 10_000;

const ROSTER_PATHS: Record<RosterKind, string> = {
  asociado: "usuarios/asociados",
  sectorial: "usuarios/sectoriales",
};

// Configuration ---------------------------------------------------------------

type IntranetUrlVariable = "NUXT_INTRANET_API_URL" | "NUXT_ROLE_API_URL";

/** Configuration problems already logged: each one is logged once per process. */
const loggedConfigProblems = new Set<string>();

function logConfigProblemOnce(
  level: "warn" | "error",
  variable: IntranetUrlVariable,
  reason: string,
): void {
  const key = `${variable}\n${reason}`;
  if (loggedConfigProblems.has(key)) return;
  loggedConfigProblems.add(key);
  if (level === "error") logError("intranet.config", reason, { variable });
  else logWarn("intranet.config", { variable, reason });
}

/** Lets tests see the once-only configuration logs again. */
export function resetIntranetConfigLogForTests(): void {
  loggedConfigProblems.clear();
}

/**
 * A host reachable only inside the Docker network: one label with no dot,
 * such as the service name `intranet` (docs/intranet.md, 5.8). An IP address
 * never counts: IPv4 has dots and IPv6 literals come in brackets.
 */
function isInternalServiceHost(hostname: string): boolean {
  return (
    hostname !== "" && !hostname.includes(".") && !hostname.startsWith("[")
  );
}

/**
 * Whether the platform may send the intranet token to this URL: `https:`
 * always; `http:` outside production, or toward an internal host with no
 * dot (`http://intranet`). Anything else is never allowed. `production`
 * defaults to NODE_ENV, read on every call.
 */
export function isIntranetUrlAllowed(
  url: URL,
  production: boolean = process.env.NODE_ENV === "production",
): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return !production || isInternalServiceHost(url.hostname);
}

/**
 * The URL in one of the intranet variables, or null when it is unset, blank
 * or not usable (invalid, another scheme, or `http:` to a public host in
 * production): it then counts as unconfigured and the problem is logged
 * once.
 */
function readIntranetUrl(variable: IntranetUrlVariable): URL | null {
  const raw = process.env[variable]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    logConfigProblemOnce("warn", variable, "not a valid URL");
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    logConfigProblemOnce("warn", variable, "only https: or http: URLs");
    return null;
  }
  if (!isIntranetUrlAllowed(url)) {
    logConfigProblemOnce(
      "error",
      variable,
      "http: is not allowed in production (the token would travel in clear); use https: or an internal host without dots such as http://intranet",
    );
    return null;
  }
  return url;
}

/**
 * `NUXT_INTRANET_API_URL` without trailing slashes, or null when unset or
 * not usable (see readIntranetUrl).
 */
export function getIntranetApiBaseUrl(): string | null {
  const url = readIntranetUrl("NUXT_INTRANET_API_URL");
  return url ? url.toString().replace(/\/+$/, "") : null;
}

/**
 * The role lookup URL: `NUXT_ROLE_API_URL` when set and usable; otherwise
 * `{NUXT_INTRANET_API_URL}/user/role`; null when neither is usable.
 */
export function getRoleApiUrl(): string | null {
  const explicit = readIntranetUrl("NUXT_ROLE_API_URL");
  if (explicit) return explicit.toString();
  const base = getIntranetApiBaseUrl();
  return base ? intranetUrl(base, "user/role") : null;
}

function intranetToken(): string | null {
  return process.env.NUXT_INTRANET_API_TOKEN?.trim() || null;
}

/**
 * Headers every intranet request carries: `Authorization: Bearer <token>`
 * when `NUXT_INTRANET_API_TOKEN` is set (blank counts as unset). The token
 * is a secret: never log these headers.
 */
export function intranetAuthHeaders(): Record<string, string> {
  const token = intranetToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Whether intranet requests are authenticated (`NUXT_INTRANET_API_TOKEN`
 * set). Only an authenticated lookup can say an account does not exist.
 */
export function isIntranetAuthenticated(): boolean {
  return intranetToken() !== null;
}

/**
 * Whether the role lookup sends the token, and so can tell that an account
 * does not exist: a token is set and the lookup goes to the intranet the
 * token is for, the origin of NUXT_INTRANET_API_URL (or there is no base,
 * and NUXT_ROLE_API_URL is the only intranet configured). A NUXT_ROLE_API_URL
 * on another origin (a leftover such as an example host) never receives the
 * token: the lookup is then
 * unauthenticated, nobody loses access, and the mismatch is logged once.
 */
export function isRoleLookupAuthenticated(
  roleUrl: string | null = getRoleApiUrl(),
): boolean {
  if (!roleUrl || !isIntranetAuthenticated()) return false;
  const base = getIntranetApiBaseUrl();
  if (!base) return true;
  if (new URL(roleUrl).origin === new URL(base).origin) return true;
  logConfigProblemOnce(
    "error",
    "NUXT_ROLE_API_URL",
    "not on the origin of NUXT_INTRANET_API_URL: the role lookup does not send the token, so no account loses access; leave NUXT_ROLE_API_URL unset",
  );
  return false;
}

/** Joins the base URL and a path, tolerating slashes on either side. */
export function intranetUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

// Log correlation -------------------------------------------------------------

/** Hex characters of the HMAC kept as the account reference. */
const ACCOUNT_REF_LENGTH = 12;

/**
 * A reference to correlate the log lines of one account without writing its
 * email: the first 12 hex characters of HMAC-SHA256 over the trimmed,
 * lowercased email, keyed with the server secret (`BETTER_AUTH_SECRET`, or
 * `APP_SECRET`, the one better-auth is given). Log it under the key
 * `accountRef`: the logger redacts every key named like `email`. Null when
 * no secret is set, since a plain hash of an email can be reversed with a
 * list of addresses.
 */
export function emailFingerprint(email: string): string | null {
  const secret =
    process.env.BETTER_AUTH_SECRET?.trim() || process.env.APP_SECRET?.trim();
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, ACCOUNT_REF_LENGTH);
}

// Role lookup -----------------------------------------------------------------

// The intranet serializes nullable columns: an account without initials or
// university answers with null, which must not discard the whole lookup.
const nullableText = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || null);

/**
 * The 200 answer of the role lookup. `id` is the intranet `users.id`; the
 * Intranet always sends it, but a missing or null `id` is read as null so an
 * older answer never breaks sign-in. Any other key is ignored; a field of the
 * wrong type invalidates the answer.
 */
export const intranetRoleResponseSchema = z.object({
  id: intranetIdSchema.nullish().transform((value) => value ?? null),
  role: z.string().trim().min(1),
  name: nullableText,
  initials: nullableText,
  university: nullableText,
});

/** An account as the intranet describes it. `role` is its `users.type`, compared literally. */
export type IntranetAccount = z.output<typeof intranetRoleResponseSchema>;

/** The exact body of the private group's 404 for an unknown account. */
const notFoundBodySchema = z.strictObject({ error: z.literal("not_found") });

/** Why a role lookup failed, for logs. */
export type IntranetLookupFailure =
  "network" | "timeout" | "status" | "invalid_json" | "invalid_payload";

/**
 * How a role lookup went:
 * - `ok`: the intranet knows the account;
 * - `notFound`: the intranet has no such account (or it has no type). Only
 *   an authenticated lookup (isRoleLookupAuthenticated) that answered 404 with
 *   exactly `{"error":"not_found"}`, without a redirect, counts;
 * - `failed`: anything else (network error, timeout, any other status, any
 *   other 404 such as an unauthenticated one or a missing route, including
 *   the removed public `{"error":"Usuario no encontrado"}`, invalid JSON or
 *   payload). It says
 *   nothing about the account;
 * - `unconfigured`: no usable role lookup URL (getRoleApiUrl).
 */
export type IntranetRoleLookup =
  | { outcome: "ok"; account: IntranetAccount }
  | { outcome: "notFound" }
  | {
      outcome: "failed";
      reason: IntranetLookupFailure;
      /** The HTTP status, or null when no answer arrived. */
      status: number | null;
    }
  | { outcome: "unconfigured" };

const INVALID_JSON = Symbol("invalid JSON");

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return INVALID_JSON;
  }
}

/**
 * Asks the intranet who an email is: `POST` to getRoleApiUrl with
 * `{"email"}`, `Accept` and `Content-Type: application/json` and the token
 * when it is for that URL (isRoleLookupAuthenticated), within
 * INTRANET_TIMEOUT_MS. Never throws. A failure is
 * logged here (scope `intranet.role`, with the `accountRef` of the email
 * and never the email itself); `ok`, `notFound` and `unconfigured` are left
 * to the caller to log.
 */
export async function lookupIntranetRole(
  email: string,
): Promise<IntranetRoleLookup> {
  const url = getRoleApiUrl();
  if (!url) return { outcome: "unconfigured" };

  // The token only travels to the intranet it is for (isRoleLookupAuthenticated).
  const authenticated = isRoleLookupAuthenticated(url);
  const fail = (
    reason: IntranetLookupFailure,
    status: number | null,
    detail?: string,
  ): IntranetRoleLookup => {
    logWarn("intranet.role", {
      reason,
      status,
      accountRef: emailFingerprint(email),
      ...(detail ? { detail } : {}),
    });
    return { outcome: "failed", reason, status };
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        // The intranet API token, when configured (never logged).
        ...(authenticated ? intranetAuthHeaders() : {}),
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(INTRANET_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return fail(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      null,
      name,
    );
  }

  if (!response.ok) {
    const body = await readJson(response);
    if (
      response.status === 404 &&
      authenticated &&
      !response.redirected &&
      notFoundBodySchema.safeParse(body).success
    ) {
      return { outcome: "notFound" };
    }
    return fail("status", response.status);
  }

  const payload = await readJson(response);
  if (payload === INVALID_JSON) return fail("invalid_json", response.status);
  const parsed = intranetRoleResponseSchema.safeParse(payload);
  if (!parsed.success) return fail("invalid_payload", response.status);
  return { outcome: "ok", account: parsed.data };
}

// Roster ----------------------------------------------------------------------

export class IntranetUnavailableError extends Error {
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`Intranet request to ${path} failed: ${reason}`);
    this.name = "IntranetUnavailableError";
  }
}

/** Fetches one roster list. Throws IntranetUnavailableError on any failure. */
export async function fetchIntranetRoster(
  base: string,
  kind: RosterKind,
): Promise<IntranetRosterEntry[]> {
  const path = ROSTER_PATHS[kind];
  let response: Response;
  try {
    response = await fetch(intranetUrl(base, path), {
      headers: { Accept: "application/json", ...intranetAuthHeaders() },
      signal: AbortSignal.timeout(INTRANET_TIMEOUT_MS),
    });
  } catch (error) {
    throw new IntranetUnavailableError(
      path,
      error instanceof Error ? error.name : "network",
    );
  }
  if (!response.ok) {
    throw new IntranetUnavailableError(path, `status ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new IntranetUnavailableError(path, "invalid JSON");
  }
  const parsed = intranetRosterResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new IntranetUnavailableError(path, "unexpected payload");
  }
  return parsed.data.data;
}

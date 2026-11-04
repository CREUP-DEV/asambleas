import { logWarn } from "../core/logger";
import {
  intranetRosterResponseSchema,
  type IntranetRosterEntry,
  type RosterKind,
} from "./roster";

/**
 * Client for the CREUP intranet API (Laravel, `routes/api.php`):
 * - `GET {base}/usuarios/asociados` and `GET {base}/usuarios/sectoriales`
 *   return `{ data: [...], generated_at }`;
 * - `POST {base}/user/role` returns `{ role, name, initials, university }`
 *   for an email, or 404 when the intranet has no such account.
 */

export const INTRANET_TIMEOUT_MS = 10_000;

const ROSTER_PATHS: Record<RosterKind, string> = {
  asociado: "usuarios/asociados",
  sectorial: "usuarios/sectoriales",
};

/** `NUXT_INTRANET_API_URL` without trailing slashes, or null when unset or invalid. */
export function getIntranetApiBaseUrl(): string | null {
  const raw = process.env.NUXT_INTRANET_API_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    logWarn("intranet.config", {
      reason: "NUXT_INTRANET_API_URL is not a valid URL",
    });
    return null;
  }
}

/** Joins the base URL and a path, tolerating slashes on either side. */
export function intranetUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

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
      headers: { Accept: "application/json" },
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

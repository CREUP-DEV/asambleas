/**
 * Pure decisions of the global auth middleware (auth.global.ts), kept apart
 * so they can be tested without Nuxt. The `-` prefix keeps Nuxt from
 * registering this file as a middleware.
 */
import { errorStatus } from "~/composables/api/useApi";

/** A verified session is checked again after this long. */
export const SESSION_RECHECK_INTERVAL_MS = 2 * 60 * 1000;

const LOGIN_ROUTE_PATTERN = /^(\/[a-z]{2})?\/login\/?$/;

/** The login page, with or without a locale prefix (`/login`, `/en/login`). */
export function isLoginPath(path: string): boolean {
  return LOGIN_ROUTE_PATTERN.test(path);
}

/**
 * Whether the navigation must ask the server about the session. Only a
 * client that already verified it may skip: within the interval, and when
 * only the query or the hash changes (the document page writes
 * `?enmienda=` on every amendment it opens). The server, and a client
 * whose last check never confirmed the session, always ask.
 */
export function shouldCheckSession(input: {
  client: boolean;
  verified: boolean;
  lastCheckedAt: number;
  now: number;
  toPath: string;
  fromPath: string | undefined;
}): boolean {
  if (!input.client || !input.verified) return true;
  if (input.toPath === input.fromPath) return false;
  return input.now - input.lastCheckedAt >= SESSION_RECHECK_INTERVAL_MS;
}

/**
 * What a failed session check means. Only the server saying the session
 * is gone (401; 403 too, although GET /api/auth/session never answers it)
 * sends to the login page. A network error, a 429 or a 5xx during a
 * deployment says nothing about the session: the navigation goes on and
 * the next one asks again.
 */
export function sessionFailureAction(error: unknown): "redirect" | "keep" {
  const status = errorStatus(error);
  return status === 401 || status === 403 ? "redirect" : "keep";
}

/**
 * The locale a path is in under `prefix_except_default`: its first segment
 * when that is a locale code, the default locale otherwise.
 */
export function localeOfPath<Code extends string>(
  path: string,
  localeCodes: readonly Code[],
  defaultLocale: Code,
): Code {
  const first = /^\/([^/?#]+)/.exec(path)?.[1];
  const code = localeCodes.find((candidate) => candidate === first);
  return code ?? defaultLocale;
}

/**
 * The `redirect` query of the login page when it is a path of this site;
 * null otherwise. Rejects protocol-relative targets (`//host`, `/\host`),
 * which browsers read as another site, and the login page itself.
 */
export function safeRedirectPath(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Control characters (a tab or a newline inside `/\t/host`) are dropped
  // by URL parsers, which would turn the path into another host.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const path = raw.split(/[?#]/, 1)[0] ?? raw;
  if (isLoginPath(path)) return null;
  return raw;
}

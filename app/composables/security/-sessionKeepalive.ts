/**
 * When the browser asks better-auth for its session
 * (app/plugins/session-keepalive.client.ts). Each ask does two things:
 *
 * - It renews the session: a session lasts 7 days (`expiresIn`) and
 *   better-auth extends the row and the cookie together at most once a day
 *   (`updateAge`), only in an answer that reaches the browser. The app's own
 *   endpoints never refresh it (requireAuth).
 * - It keeps better-auth's session cookie cache warm. The ask skips the cache
 *   (`disableCookieCache`), so better-auth reads the session once and sends a
 *   fresh `session_data` cookie (`cookieCache.maxAge`, 5 minutes). While that
 *   cookie lives, every request of the app checks the session from it
 *   (requireAuth) instead of reading `sessions` and `users`: about 2 queries
 *   fewer per request, some 600 per vote with a full room. Asking once that
 *   cookie has expired would always find it gone, so a visible page asks a
 *   little before (SESSION_KEEPALIVE_INTERVAL_MS plus jitter and the check
 *   period stay under it). `refreshCache`, which would renew the cookie
 *   without the read, is for setups without a database: better-auth turns
 *   it off here.
 *
 * Revocation is unaffected (users.access_revoked_at is read on every
 * request); signing out on another device takes up to the cache's 5 minutes
 * to be noticed, as AGENTS.md accepts.
 */

/** better-auth's cookie cache lifetime (server/utils/auth/auth.ts, cookieCache.maxAge). */
export const SESSION_COOKIE_CACHE_MS = 5 * 60_000;
/** Least time between two asks from this browser (every tab shares it). */
export const SESSION_KEEPALIVE_INTERVAL_MS = 3.5 * 60_000;
/**
 * Most each device adds, at random, to the interval before its next ask, so
 * the ~100 devices of a room that opened together drift apart.
 */
export const SESSION_KEEPALIVE_JITTER_MS = 30_000;
/** How often a visible page checks whether an ask is due (no request unless it is). */
export const SESSION_KEEPALIVE_CHECK_MS = 20_000;
/**
 * Most the first ask waits, at random, once the app is ready: a room that
 * opens the app together stays well under better-auth's rate limit (100
 * asks per 10 s per IP and path), which a whole venue shares behind its NAT.
 */
export const SESSION_KEEPALIVE_READY_JITTER_MS = 20_000;
/** Most an ask waits, at random, when a hidden page is shown again. */
export const SESSION_KEEPALIVE_VISIBLE_JITTER_MS = 5_000;
/**
 * Most an ask triggered by the network coming back waits, at random, so a
 * room that loses the wifi together does not ask in the same instant as it
 * reconnects its live streams.
 */
export const SESSION_KEEPALIVE_ONLINE_JITTER_MS = 10_000;
/** Where the time of the last ask is kept (per browser, never the account's). */
export const SESSION_KEEPALIVE_STORAGE_KEY = "creup:session-keepalive-at";

/**
 * Whether it is time to ask again: never asked, asked at least an interval
 * (plus this device's `jitter`) ago, or a stored time in the future (a clock
 * moved back), which would otherwise block the keepalive until the clock
 * caught up.
 */
export function sessionKeepaliveDue(
  lastAt: number | null,
  now: number,
  jitter = 0,
): boolean {
  if (lastAt === null || !Number.isFinite(lastAt)) return true;
  if (lastAt > now) return true;
  return now - lastAt >= SESSION_KEEPALIVE_INTERVAL_MS + jitter;
}

/** A random wait in [0, max) ms. */
export function randomWait(max: number, random: () => number = Math.random) {
  return Math.floor(random() * max);
}

/** The stored time of the last ask, or null when there is none or storage fails. */
export function readSessionKeepaliveAt(
  storage: Pick<Storage, "getItem"> | null | undefined,
): number | null {
  try {
    const raw = storage?.getItem(SESSION_KEEPALIVE_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores the time of an ask; a storage that fails is ignored. */
export function writeSessionKeepaliveAt(
  storage: Pick<Storage, "setItem"> | null | undefined,
  at: number,
): void {
  try {
    storage?.setItem(SESSION_KEEPALIVE_STORAGE_KEY, String(at));
  } catch {
    // Private windows and blocked site data: the in-memory time still holds.
  }
}

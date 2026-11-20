/**
 * When the browser asks better-auth for its session, which is what renews
 * the session cookie (app/plugins/session-keepalive.client.ts).
 *
 * A session lasts 7 days (`expiresIn`) and better-auth extends the row and
 * the cookie together at most once a day (`updateAge`), and only in an
 * answer that reaches the browser: the app's own endpoints never refresh it
 * (requireAuth). Asking once an hour while the app is used extends it
 * within the hour it becomes due, for about one small request per device and
 * hour; asking more often renews nothing more.
 */

/** Least time between two asks from this browser (every tab shares it). */
export const SESSION_KEEPALIVE_INTERVAL_MS = 60 * 60_000;
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
 * ago, or a stored time in the future (a clock moved back), which would
 * otherwise block the keepalive until the clock caught up.
 */
export function sessionKeepaliveDue(
  lastAt: number | null,
  now: number,
): boolean {
  if (lastAt === null || !Number.isFinite(lastAt)) return true;
  if (lastAt > now) return true;
  return now - lastAt >= SESSION_KEEPALIVE_INTERVAL_MS;
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

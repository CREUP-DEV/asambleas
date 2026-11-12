/**
 * When useAssemblyLive gives up on a stream that may have died in silence.
 *
 * The server sends a `ping` every 25 s (server/utils/live/sse.ts), so an
 * open stream that delivered nothing (`ready`, `change` or `ping`) for a
 * minute is dead even if the browser still reports it open: a laptop that
 * changed access point, a phone unlocked between votes, a router that lost
 * its NAT table. Firefox and Safari can take minutes to notice by
 * themselves.
 */

/** Silence after which a visible page reopens its stream. */
export const LIVE_STALE_AFTER_MS = 60_000;
/** How often the watchdog looks. */
export const LIVE_WATCHDOG_TICK_MS = 15_000;
/**
 * A page hidden longer than this checks its stream when it is shown again,
 * and reopens it at once (instead of a minute later) when it has been
 * silent for LIVE_SHOW_SILENCE_MS.
 */
export const LIVE_RESUME_AFTER_HIDDEN_MS = 30_000;
/**
 * Silence that, after such a hide, means a heartbeat was missed: one
 * period (25 s) and room for a ping held up by a busy server.
 */
export const LIVE_SHOW_SILENCE_MS = 40_000;
/**
 * Most a reopen triggered by the network coming back waits, at random, so a
 * room full of delegates does not reconnect in the same instant.
 */
export const LIVE_ONLINE_JITTER_MS = 2_000;
/**
 * A page restored from the browser's cache leaves alone a stream opened this
 * recently: `visibilitychange` may have reopened it a moment before
 * `pageshow`, and browsers fire the two in either order.
 */
export const LIVE_RESTORE_FRESH_MS = 1_000;

/**
 * Whether the watchdog must reopen an open stream. Only while the page is
 * visible: hidden tabs are throttled and may legitimately hear nothing, and
 * they are checked when shown again (shouldReopenOnShow).
 */
export function isLiveStreamStale(input: {
  now: number;
  lastMessageAt: number;
  visible: boolean;
  /** A stream is open or opening (not waiting on a reconnect backoff). */
  streaming: boolean;
}): boolean {
  if (!input.streaming || !input.visible) return false;
  return input.now - input.lastMessageAt > LIVE_STALE_AFTER_MS;
}

/**
 * Whether a page shown again must reopen its stream now. A short hide never
 * does. After a long one it does when the stream missed a heartbeat (the
 * socket may have frozen with the page), or when no stream is open
 * (waiting on a backoff: retry now rather than later). A stream that kept
 * receiving pings while hidden missed nothing and is left alone.
 */
export function shouldReopenOnShow(input: {
  now: number;
  hiddenAt: number | null;
  lastMessageAt: number;
  streaming: boolean;
}): boolean {
  if (input.hiddenAt === null) return false;
  if (input.now - input.hiddenAt <= LIVE_RESUME_AFTER_HIDDEN_MS) return false;
  if (!input.streaming) return true;
  return input.now - input.lastMessageAt > LIVE_SHOW_SILENCE_MS;
}

/**
 * Whether a `pageshow` must reopen the stream: only a page restored from the
 * browser's cache (`persisted`), whose stream missed everything in between,
 * and only when no stream was opened in the last LIVE_RESTORE_FRESH_MS (the
 * visibility handler already reopened it).
 */
export function shouldReopenOnRestore(input: {
  persisted: boolean;
  now: number;
  /** When the current stream was opened; null if none ever was. */
  openedAt: number | null;
}): boolean {
  if (!input.persisted) return false;
  if (input.openedAt === null) return true;
  return input.now - input.openedAt > LIVE_RESTORE_FRESH_MS;
}

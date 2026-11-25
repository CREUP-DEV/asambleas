/**
 * When the documentation package is built ahead of anyone asking
 * (service.ts), apart so the `document-pages` job (documentPages.ts) can
 * wait for it without importing the package's service.
 */

/** Quiet time after a change before the package is built ahead of anyone asking. */
export const PREBUILD_DELAY_MS = 2 * 60_000;

/** Assemblies whose package is built ahead: those whose documentation moves. */
export const PREBUILD_STATUSES: ReadonlySet<string> = new Set([
  "convened",
  "in_session",
]);

/** What the prebuild takes past its quiet time to queue and reach a text. */
const PAGES_JOB_MARGIN_MS = 60_000;

/**
 * How long a `document-pages` job waits before it runs, in seconds (pg-boss
 * `startAfter`), for an assembly in `status`. Where the package is built
 * ahead, the change that moved a text's layout also schedules a prebuild
 * that renders that PDF and stores its map anyway, so the job waits for it
 * instead of rendering the same PDF first; it then finds the map current and
 * does nothing. Elsewhere it runs at once (undefined).
 */
export function pagesJobStartAfter(status: string): number | undefined {
  if (!PREBUILD_STATUSES.has(status)) return undefined;
  return Math.ceil((PREBUILD_DELAY_MS + PAGES_JOB_MARGIN_MS) / 1000);
}

/** The least `retryAfter` a pending GET …/pages answers, in seconds. */
export const PAGES_RETRY_AFTER_MIN_S = 5;

/**
 * The `retryAfter` of a pending GET …/pages, in seconds: what is left of
 * the job's `startAfter` (`startAfterSeconds`, undefined when it runs at
 * once) since it was queued at `queuedAt` (ms), never under
 * PAGES_RETRY_AFTER_MIN_S: a job already due, or rendering, gets the floor.
 */
export function pagesRetryAfter(
  queuedAt: number,
  startAfterSeconds: number | undefined,
  now: number,
): number {
  if (startAfterSeconds === undefined) return PAGES_RETRY_AFTER_MIN_S;
  const left = Math.ceil(startAfterSeconds - (now - queuedAt) / 1000);
  return Math.max(PAGES_RETRY_AFTER_MIN_S, left);
}

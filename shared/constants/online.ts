/**
 * An account counts as online when it used the platform within this window
 * (server/utils/live/online.ts): any request it made, or the heartbeat of a
 * live stream it keeps open (every 25 s on an assembly's pages).
 */
export const ONLINE_WINDOW_MINUTES = 5;
export const ONLINE_WINDOW_MS = ONLINE_WINDOW_MINUTES * 60_000;

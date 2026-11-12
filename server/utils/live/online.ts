import { ONLINE_WINDOW_MS } from "../../../shared/constants/online";

/**
 * When each account was last seen using the platform, kept in this
 * process's memory only (no table, no history, never logged), like the
 * draft editors' presence (./presence.ts). Production runs one app
 * container, so one process sees every request; after a restart everyone
 * reads as offline until their next request or heartbeat.
 *
 * It marks the real person behind a request (`context.realUser`): while an
 * Admin acts as an account, the Admin is online and the account is not.
 * Only whoever manages users (user:manage_roles) or reads the statistics
 * (stats:view) sees it, as a dot by the account's name.
 */

/** Accounts tracked at once; past it, the ones not seen lately are dropped. */
export const MAX_TRACKED_ACCOUNTS = 10_000;

const lastSeen = new Map<string, number>();

function sweep(now: number): void {
  for (const [userId, seen] of lastSeen) {
    if (now - seen > ONLINE_WINDOW_MS) lastSeen.delete(userId);
  }
}

/** The account did something now. */
export function markSeen(userId: string, now: number = Date.now()): void {
  // Re-inserted at the end, so the oldest sit first when sweeping.
  lastSeen.delete(userId);
  lastSeen.set(userId, now);
  if (lastSeen.size > MAX_TRACKED_ACCOUNTS) {
    sweep(now);
    // Still full of accounts seen within the window: drop the oldest.
    while (lastSeen.size > MAX_TRACKED_ACCOUNTS) {
      const oldest = lastSeen.keys().next().value;
      if (oldest === undefined) break;
      lastSeen.delete(oldest);
    }
  }
}

/** Whether the account used the platform within ONLINE_WINDOW_MS. */
export function isOnline(userId: string, now: number = Date.now()): boolean {
  const seen = lastSeen.get(userId);
  return seen !== undefined && now - seen <= ONLINE_WINDOW_MS;
}

/** For tests. */
export function resetOnline(): void {
  lastSeen.clear();
}

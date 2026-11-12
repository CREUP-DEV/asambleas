import { beforeEach, describe, expect, it } from "vitest";
import { ONLINE_WINDOW_MS } from "../../../shared/constants/online";
import {
  MAX_TRACKED_ACCOUNTS,
  isOnline,
  markSeen,
  resetOnline,
} from "./online";

describe("online accounts", () => {
  beforeEach(() => resetOnline());

  it("counts an account online within the window and offline after it", () => {
    markSeen("u1", 1_000);
    expect(isOnline("u1", 1_000)).toBe(true);
    expect(isOnline("u1", 1_000 + ONLINE_WINDOW_MS)).toBe(true);
    expect(isOnline("u1", 1_001 + ONLINE_WINDOW_MS)).toBe(false);
    expect(isOnline("never", 1_000)).toBe(false);
  });

  it("moves the window with every request or heartbeat", () => {
    markSeen("u1", 0);
    markSeen("u1", ONLINE_WINDOW_MS);
    expect(isOnline("u1", ONLINE_WINDOW_MS * 2)).toBe(true);
  });

  it("keeps at most MAX_TRACKED_ACCOUNTS, dropping the oldest", () => {
    for (let i = 0; i <= MAX_TRACKED_ACCOUNTS; i += 1) markSeen(`u${i}`, i);
    const now = MAX_TRACKED_ACCOUNTS;
    expect(isOnline("u0", now)).toBe(false);
    expect(isOnline(`u${MAX_TRACKED_ACCOUNTS}`, now)).toBe(true);
  });
});

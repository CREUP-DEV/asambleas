import { describe, expect, it } from "vitest";
import {
  randomWait,
  readSessionKeepaliveAt,
  SESSION_COOKIE_CACHE_MS,
  SESSION_KEEPALIVE_CHECK_MS,
  SESSION_KEEPALIVE_INTERVAL_MS,
  SESSION_KEEPALIVE_JITTER_MS,
  SESSION_KEEPALIVE_READY_JITTER_MS,
  SESSION_KEEPALIVE_STORAGE_KEY,
  sessionKeepaliveDue,
  writeSessionKeepaliveAt,
} from "./-sessionKeepalive";

describe("randomWait", () => {
  it("stays in [0, max)", () => {
    expect(randomWait(1_000, () => 0)).toBe(0);
    expect(randomWait(1_000, () => 0.999_999)).toBe(999);
  });
});

const now = Date.UTC(2026, 10, 20, 10, 0, 0);

describe("sessionKeepaliveDue", () => {
  it("asks when it never asked", () => {
    expect(sessionKeepaliveDue(null, now)).toBe(true);
  });

  it("waits an interval between two asks", () => {
    expect(sessionKeepaliveDue(now - 1_000, now)).toBe(false);
    expect(
      sessionKeepaliveDue(now - SESSION_KEEPALIVE_INTERVAL_MS + 1, now),
    ).toBe(false);
    expect(sessionKeepaliveDue(now - SESSION_KEEPALIVE_INTERVAL_MS, now)).toBe(
      true,
    );
  });

  it("adds this device's jitter to the interval", () => {
    const last = now - SESSION_KEEPALIVE_INTERVAL_MS;
    expect(sessionKeepaliveDue(last, now, 10_000)).toBe(false);
    expect(sessionKeepaliveDue(last - 10_000, now, 10_000)).toBe(true);
  });

  it("asks again before the session cookie cache expires", () => {
    // Worst case: the longest jitter, and the due moment just missed by a check.
    const longestGap =
      SESSION_KEEPALIVE_INTERVAL_MS +
      SESSION_KEEPALIVE_JITTER_MS +
      SESSION_KEEPALIVE_CHECK_MS;
    expect(longestGap).toBeLessThan(SESSION_COOKIE_CACHE_MS);
  });

  it("keeps a room behind one IP under better-auth's rate limit", () => {
    // 100 asks per 10 s per IP and path. A room of 100 devices that opens
    // the app together spreads its first asks over the ready jitter, and
    // then asks about once per interval each.
    const devices = 100;
    const firstAsksPer10s =
      devices * Math.min(1, 10_000 / SESSION_KEEPALIVE_READY_JITTER_MS);
    expect(firstAsksPer10s).toBeLessThan(100);
    const steadyAsksPer10s = (devices * 10_000) / SESSION_KEEPALIVE_INTERVAL_MS;
    expect(steadyAsksPer10s).toBeLessThan(10);
  });

  it("asks when the stored time is in the future (the clock went back)", () => {
    expect(sessionKeepaliveDue(now + 60_000, now)).toBe(true);
  });

  it("asks when the stored time is not a number", () => {
    expect(sessionKeepaliveDue(Number.NaN, now)).toBe(true);
  });
});

describe("the stored time of the last ask", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      values,
    };
  }

  it("round-trips through the storage", () => {
    const storage = memoryStorage();
    expect(readSessionKeepaliveAt(storage)).toBeNull();
    writeSessionKeepaliveAt(storage, now);
    expect(storage.values.get(SESSION_KEEPALIVE_STORAGE_KEY)).toBe(String(now));
    expect(readSessionKeepaliveAt(storage)).toBe(now);
  });

  it("ignores garbage and a storage that throws", () => {
    const storage = memoryStorage();
    storage.setItem(SESSION_KEEPALIVE_STORAGE_KEY, "soon");
    expect(readSessionKeepaliveAt(storage)).toBeNull();

    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readSessionKeepaliveAt(blocked)).toBeNull();
    expect(() => writeSessionKeepaliveAt(blocked, now)).not.toThrow();
    expect(readSessionKeepaliveAt(null)).toBeNull();
  });
});

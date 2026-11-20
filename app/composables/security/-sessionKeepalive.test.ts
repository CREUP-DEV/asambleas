import { describe, expect, it } from "vitest";
import {
  readSessionKeepaliveAt,
  SESSION_KEEPALIVE_INTERVAL_MS,
  SESSION_KEEPALIVE_STORAGE_KEY,
  sessionKeepaliveDue,
  writeSessionKeepaliveAt,
} from "./-sessionKeepalive";

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

  it("asks at most once an hour and at least once a day", () => {
    expect(SESSION_KEEPALIVE_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60_000);
    expect(SESSION_KEEPALIVE_INTERVAL_MS).toBeLessThan(24 * 60 * 60_000);
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

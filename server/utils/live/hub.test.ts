import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A pg client whose database is down: connect() fails, and the client also
 * emits "error" and "end", as pg does when the socket is refused.
 */
const created: FakeClient[] = [];
let databaseUp = false;

class FakeClient extends EventEmitter {
  constructor() {
    super();
    created.push(this);
  }

  async connect(): Promise<void> {
    if (databaseUp) return;
    const error = new Error("connect ECONNREFUSED");
    this.emit("error", error);
    this.emit("end");
    throw error;
  }

  async query(): Promise<void> {}

  async end(): Promise<void> {}
}

vi.mock("pg", () => ({ default: { Client: FakeClient } }));
vi.mock("../core/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const { startLiveHub, stopLiveHub } = await import("./hub");

describe("live hub reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    databaseUp = false;
    process.env.DATABASE_URL = "postgres://test@localhost:5432/test";
  });

  afterEach(async () => {
    await stopLiveHub();
    vi.useRealTimers();
  });

  it("keeps one pending retry per failure while the database is down", async () => {
    await startLiveHub();
    expect(created).toHaveLength(1);

    // Backoff 1s, 2s, 4s, 8s, 16s, 30s, 30s: one new client per round.
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(created).toHaveLength(8);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops retrying once connected", async () => {
    await startLiveHub();
    databaseUp = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the pending retry when stopped", async () => {
    await startLiveHub();
    await stopLiveHub();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(created).toHaveLength(1);
  });

  it("tolerates a late error on a client it already dropped", async () => {
    await startLiveHub();
    expect(() => created[0]!.emit("error", new Error("late"))).not.toThrow();
  });
});

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

const { startLiveHub, stopLiveHub, subscribeToAll, subscribeToAssembly } =
  await import("./hub");

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

describe("live hub resync after a lost connection", () => {
  const unsubscribes: (() => void)[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    databaseUp = true;
    process.env.DATABASE_URL = "postgres://test@localhost:5432/test";
  });

  afterEach(async () => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    await stopLiveHub();
    vi.useRealTimers();
  });

  function listen(assemblyId: string) {
    const listener = vi.fn();
    unsubscribes.push(subscribeToAssembly(assemblyId, listener));
    return listener;
  }

  it("tells nobody to refetch on a clean first start", async () => {
    const listener = listen("assembly-a");
    await startLiveHub();
    expect(listener).not.toHaveBeenCalled();
  });

  it("sends one poll per assembly with open streams once it listens again", async () => {
    const a1 = listen("assembly-a");
    const a2 = listen("assembly-a");
    const b = listen("assembly-b");
    const any = vi.fn();
    unsubscribes.push(subscribeToAll(any));
    await startLiveHub();

    created[0]!.emit("end");
    expect(a1).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(created).toHaveLength(2);
    const poll = {
      assemblyId: "assembly-a",
      entityType: "assembly",
      entityId: "assembly-a",
      type: "poll",
    };
    expect(a1).toHaveBeenCalledExactlyOnceWith(poll);
    expect(a2).toHaveBeenCalledExactlyOnceWith(poll);
    // Every stream of an assembly gets the same object (serialized once).
    expect(a2.mock.calls[0]![0]).toBe(a1.mock.calls[0]![0]);
    expect(b).toHaveBeenCalledExactlyOnceWith({
      ...poll,
      assemblyId: "assembly-b",
      entityId: "assembly-b",
    });
    expect(any).not.toHaveBeenCalled();
  });

  it("resyncs once per recovery, not on every later reconnect without failure", async () => {
    const listener = listen("assembly-a");
    await startLiveHub();
    created[0]!.emit("end");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("also resyncs once it listens after a failed start", async () => {
    databaseUp = false;
    const listener = listen("assembly-a");
    await startLiveHub();
    databaseUp = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({ type: "poll" });
  });

  it("forgets a failure when stopped", async () => {
    databaseUp = false;
    const listener = listen("assembly-a");
    await startLiveHub();
    await stopLiveHub();
    databaseUp = true;
    await startLiveHub();
    expect(listener).not.toHaveBeenCalled();
  });
});

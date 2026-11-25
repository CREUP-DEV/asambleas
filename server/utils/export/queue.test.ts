import { describe, expect, it, vi } from "vitest";

// The export instance with pg-boss stubbed: what it listens to and when.
const calls: string[] = [];
const listeners = new Map<string, (error: unknown) => void>();
const logError = vi.fn();

vi.mock("../core/logger", () => ({ logError }));
vi.mock("pg-boss", () => ({
  PgBoss: class {
    on(event: string, listener: (error: unknown) => void) {
      calls.push(`on:${event}`);
      listeners.set(event, listener);
      return this;
    }
    async start() {
      calls.push("start");
    }
    async createQueue() {}
    getWipData() {
      return [];
    }
  },
}));

const {
  EXPORT_QUEUE_NAMES,
  EXPORT_WORKER_STALL_MS,
  PACKAGE_QUEUE_NAME,
  exportQueueHealth,
  exportWorkersStalled,
  getExportQueue,
  getExportQueueInstance,
  onExportQueueStart,
  resetExportQueueForTests,
} = await import("./queue");

describe("getExportQueue", () => {
  it("listens to errors before starting, and logs them", async () => {
    process.env.DATABASE_URL ??= "postgres://test";
    await getExportQueue();
    expect(calls.indexOf("on:error")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("on:error")).toBeLessThan(calls.indexOf("start"));

    const error = new Error("Connection terminated unexpectedly");
    expect(() => listeners.get("error")!(error)).not.toThrow();
    expect(logError).toHaveBeenCalledWith("export.queue", error);
  });

  it("calls a started instance without workers stalled", () => {
    expect(exportQueueHealth()).toBe("stalled");
  });
});

describe("onExportQueueStart", () => {
  it("registers the workers whoever starts the instance, before it is handed out", async () => {
    resetExportQueueForTests();
    const seen: unknown[] = [];
    onExportQueueStart("worker", async (instance) => {
      // Not handed out yet: no request can queue before the workers exist.
      seen.push(getExportQueueInstance(), instance);
    });
    // A request after the boot start gave up starts it with one attempt.
    const instance = await getExportQueue();
    expect(seen).toEqual([null, instance]);
    await getExportQueue();
    expect(seen).toHaveLength(2);
  });

  it("logs a starter that fails and still starts, and runs a late one at once", async () => {
    resetExportQueueForTests();
    const error = new Error("work failed");
    onExportQueueStart("broken", async () => {
      throw error;
    });
    const instance = await getExportQueue();
    expect(logError).toHaveBeenCalledWith("export.queue", error, {
      action: "start",
      starter: "broken",
    });

    const late = vi.fn(async () => {});
    onExportQueueStart("late", late);
    expect(late).toHaveBeenCalledWith(instance);
  });
});

describe("exportWorkersStalled", () => {
  const now = 10 * EXPORT_WORKER_STALL_MS;
  const worker = (name: string, lastFetchedOn: number | null, count = 0) => ({
    name,
    count,
    createdOn: 0,
    lastFetchedOn,
  });
  const fresh = [
    worker(EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT, now - 2000),
    worker(PACKAGE_QUEUE_NAME, now - 2000),
    worker("seating-images", now - 2000),
    worker("user-avatars", now - 2000),
    worker("document-images-cleanup", now - 2000),
  ];

  it("is fine while every worker fetches", () => {
    expect(exportWorkersStalled(fresh, now)).toBe(false);
  });

  it("notices a required queue without a worker", () => {
    expect(exportWorkersStalled([], now)).toBe(true);
    // Each one missing: the export, the package, the room's images, the
    // accounts' photos and the images' clean-up.
    for (const missing of fresh) {
      expect(
        exportWorkersStalled(
          fresh.filter((entry) => entry !== missing),
          now,
        ),
      ).toBe(true);
    }
  });

  it("notices an idle worker that has not fetched for a while", () => {
    const stale = now - EXPORT_WORKER_STALL_MS - 1;
    expect(
      exportWorkersStalled([...fresh, worker("user-avatars", stale)], now),
    ).toBe(true);
    // Never fetched since it was created, long ago.
    expect(
      exportWorkersStalled([...fresh, worker("document-pages", null)], now),
    ).toBe(true);
  });

  it("does not judge a worker busy with a long job", () => {
    const stale = now - EXPORT_WORKER_STALL_MS - 1;
    expect(
      exportWorkersStalled(
        [
          ...fresh.filter((entry) => entry.name !== PACKAGE_QUEUE_NAME),
          worker(PACKAGE_QUEUE_NAME, stale, 1),
        ],
        now,
      ),
    ).toBe(false);
  });
});

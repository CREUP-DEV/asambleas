import { describe, expect, it } from "vitest";
import type { LiveEventDto } from "~~/shared/types/api";
import { holdEarlyLive, keyedTrailingRefresh } from "./-liveWiring";

/** Runs that settle when the test says so. */
function controlledRuns() {
  const settles: (() => void)[] = [];
  const calls: string[] = [];
  const run = (name: string) => () => {
    calls.push(name);
    return new Promise<void>((resolve) => {
      settles.push(resolve);
    });
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    run,
    flush,
    calls,
    settle: (index: number) => settles[index]!(),
  };
}

describe("keyedTrailingRefresh", () => {
  it("runs at once when nothing is on its way", async () => {
    const control = controlledRuns();
    const refresh = keyedTrailingRefresh();
    const done = refresh("agenda", control.run("a"));
    await control.flush();
    expect(control.calls).toEqual(["a"]);
    control.settle(0);
    await done;
    expect(control.calls).toEqual(["a"]);
  });

  it("runs once for every call of the same tick on one key", async () => {
    const control = controlledRuns();
    const refresh = keyedTrailingRefresh();
    // The hub and the inbox page, or the agenda's several subscribers.
    const first = refresh("review", control.run("hub"));
    const second = refresh("review", control.run("page"));
    const third = refresh("review", control.run("bar"));
    expect(second).toBe(first);
    expect(third).toBe(first);
    await control.flush();
    expect(control.calls).toEqual(["bar"]);
    control.settle(0);
    await first;
    expect(control.calls).toEqual(["bar"]);
  });

  it("never joins a run on its way: runs once more after it", async () => {
    const control = controlledRuns();
    const refresh = keyedTrailingRefresh();
    const done = refresh("review", control.run("a"));
    await control.flush();
    expect(control.calls).toEqual(["a"]);
    // Two later batches while the first read is still on its way.
    refresh("review", control.run("b"));
    refresh("review", control.run("c"));
    await control.flush();
    expect(control.calls).toEqual(["a"]);
    control.settle(0);
    await control.flush();
    expect(control.calls).toEqual(["a", "c"]);
    control.settle(1);
    await done;
    expect(control.calls).toEqual(["a", "c"]);
  });

  it("keeps the keys apart", async () => {
    const control = controlledRuns();
    const refresh = keyedTrailingRefresh();
    refresh("agenda", control.run("agenda"));
    refresh("marks", control.run("marks"));
    await control.flush();
    expect(control.calls).toEqual(["agenda", "marks"]);
  });

  it("starts afresh once a key's runs are done", async () => {
    const control = controlledRuns();
    const refresh = keyedTrailingRefresh();
    const first = refresh("agenda", control.run("a"));
    await control.flush();
    control.settle(0);
    await first;
    await control.flush();
    const second = refresh("agenda", control.run("b"));
    expect(second).not.toBe(first);
    await control.flush();
    expect(control.calls).toEqual(["a", "b"]);
    control.settle(1);
    await second;
  });

  it("is never locked by a run that fails", async () => {
    const refresh = keyedTrailingRefresh();
    await refresh("agenda", () => Promise.reject(new Error("down")));
    let ran = false;
    await refresh("agenda", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

function event(type: string): LiveEventDto {
  return { type } as LiveEventDto;
}

/** A hub that hands each batch to the handlers registered at that moment. */
function fakeHub() {
  const handlers = new Set<(events: LiveEventDto[]) => void>();
  return {
    onLive(handler: (events: LiveEventDto[]) => void) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(events: LiveEventDto[]) {
      for (const handler of handlers) handler(events);
    },
    size: () => handlers.size,
  };
}

describe("holdEarlyLive", () => {
  it("hands the handler, as one batch, what arrived before it", () => {
    const hub = fakeHub();
    const register = holdEarlyLive(hub.onLive);
    hub.emit([event("live_changed")]);
    hub.emit([event("amendment_approved"), event("poll")]);
    const seen: string[][] = [];
    register((events) => seen.push(events.map((entry) => entry.type)));
    expect(seen).toEqual([["live_changed", "amendment_approved", "poll"]]);
  });

  it("calls nothing when nothing arrived meanwhile", () => {
    const hub = fakeHub();
    const register = holdEarlyLive(hub.onLive);
    let calls = 0;
    register(() => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it("then leaves only the handler subscribed, which hears later batches", () => {
    const hub = fakeHub();
    const register = holdEarlyLive(hub.onLive);
    hub.emit([event("live_changed")]);
    const seen: string[][] = [];
    const off = register((events) =>
      seen.push(events.map((entry) => entry.type)),
    );
    expect(hub.size()).toBe(1);
    hub.emit([event("speaker_added")]);
    expect(seen).toEqual([["live_changed"], ["speaker_added"]]);
    off();
    expect(hub.size()).toBe(0);
  });
});

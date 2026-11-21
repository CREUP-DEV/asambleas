import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveStatePushDto } from "~~/shared/types/api";
import type { LiveMessage } from "../domain/events";

const hubListeners = new Map<string, Set<(message: LiveMessage) => void>>();

vi.mock("./hub", () => ({
  subscribeToAssembly: (
    assemblyId: string,
    listener: (message: LiveMessage) => void,
  ) => {
    let set = hubListeners.get(assemblyId);
    if (!set) {
      set = new Set();
      hubListeners.set(assemblyId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  },
}));

const loadPublicLiveState = vi.fn<(id: string) => Promise<LiveStatePushDto>>();
vi.mock("./liveState", () => ({
  loadPublicLiveState: (id: string) => loadPublicLiveState(id),
}));
vi.mock("../core/logger", () => ({ logError: vi.fn() }));

const { coalescedLoader, isLiveStateChange, subscribeToLiveState } =
  await import("./statePush");

/** A promise resolved from outside, to finish a load when the test says. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function liveChanged(assemblyId: string): LiveMessage {
  return {
    assemblyId,
    entityType: "live",
    entityId: assemblyId,
    type: "live_changed",
  } as LiveMessage;
}

function emitHub(message: LiveMessage): void {
  for (const listener of hubListeners.get(message.assemblyId) ?? []) {
    listener(message);
  }
}

function push(updatedAt: string): LiveStatePushDto {
  return {
    state: {
      agendaItemId: null,
      documentId: null,
      amendmentId: null,
      amendmentBloc: [],
      amendmentBlocOptions: null,
      amendmentBlocPurpose: null,
      vote: null,
      voteDecision: null,
      message: null,
      speakersVisible: false,
      recess: null,
      speakingLimitSeconds: 180,
      updatedAt,
    },
    voteQuestionRedacted: false,
  };
}

afterEach(() => {
  loadPublicLiveState.mockReset();
});

describe("isLiveStateChange", () => {
  it("is a move of the live state", () => {
    expect(
      isLiveStateChange({ entityType: "live", type: "live_changed" }),
    ).toBe(true);
  });

  it("is not any other event, nor the hub's poll", () => {
    expect(
      isLiveStateChange({ entityType: "vote", type: "vote_recorded" }),
    ).toBe(false);
    expect(isLiveStateChange({ entityType: "assembly", type: "poll" })).toBe(
      false,
    );
  });
});

describe("coalescedLoader", () => {
  it("loads once for a request and delivers it", async () => {
    const deliver = vi.fn();
    const request = coalescedLoader({
      load: async (key) => `${key}:1`,
      deliver,
      onError: vi.fn(),
    });
    request("a");
    await flush();
    expect(deliver).toHaveBeenCalledWith("a", "a:1");
  });

  it("coalesces requests that come while it loads into one more load, delivering only its result", async () => {
    const loads = [deferred<string>(), deferred<string>()];
    const load = vi.fn(
      (_key: string) => loads[load.mock.calls.length - 1]!.promise,
    );
    const deliver = vi.fn();
    const request = coalescedLoader({ load, deliver, onError: vi.fn() });

    request("a");
    request("a");
    request("a");
    expect(load).toHaveBeenCalledTimes(1);

    // The first load ends after newer requests: it is never delivered.
    loads[0]!.resolve("old");
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);

    loads[1]!.resolve("new");
    await flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith("a", "new");
  });

  it("delivers in order, one load after the other", async () => {
    const delivered: string[] = [];
    let n = 0;
    const request = coalescedLoader({
      load: async () => `s${++n}`,
      deliver: (_key, value: string) => delivered.push(value),
      onError: vi.fn(),
    });
    request("a");
    await flush();
    request("a");
    await flush();
    expect(delivered).toEqual(["s1", "s2"]);
  });

  it("keeps keys apart", async () => {
    const deliver = vi.fn();
    const request = coalescedLoader({
      load: async (key) => key,
      deliver,
      onError: vi.fn(),
    });
    request("a");
    request("b");
    await flush();
    expect(deliver).toHaveBeenCalledWith("a", "a");
    expect(deliver).toHaveBeenCalledWith("b", "b");
  });

  it("delivers nothing when the load fails, and loads again on the next request", async () => {
    const deliver = vi.fn();
    const onError = vi.fn();
    const load = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("back");
    const request = coalescedLoader({ load, deliver, onError });
    request("a");
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    request("a");
    await flush();
    expect(deliver).toHaveBeenCalledWith("a", "back");
  });
});

describe("subscribeToLiveState", () => {
  it("loads the state once per change for every stream, and hands each the same object", async () => {
    const pushed = push("2026-11-20T10:00:00.000Z");
    loadPublicLiveState.mockResolvedValue(pushed);
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeToLiveState("asm1", first);
    const offSecond = subscribeToLiveState("asm1", second);

    emitHub(liveChanged("asm1"));
    await flush();

    expect(loadPublicLiveState).toHaveBeenCalledTimes(1);
    expect(loadPublicLiveState).toHaveBeenCalledWith("asm1");
    expect(first).toHaveBeenCalledWith(pushed);
    expect(second.mock.calls[0]![0]).toBe(first.mock.calls[0]![0]);
    offFirst();
    offSecond();
  });

  it("loads nothing for other events", async () => {
    const off = subscribeToLiveState("asm2", vi.fn());
    emitHub({
      assemblyId: "asm2",
      entityType: "amendment",
      entityId: "a1",
      type: "amendment_updated",
    } as LiveMessage);
    await flush();
    expect(loadPublicLiveState).not.toHaveBeenCalled();
    off();
  });

  it("leaves the hub once the last stream goes, and loads nothing then", async () => {
    loadPublicLiveState.mockResolvedValue(push("2026-11-20T10:00:00.000Z"));
    const offFirst = subscribeToLiveState("asm3", vi.fn());
    const offSecond = subscribeToLiveState("asm3", vi.fn());
    expect(hubListeners.get("asm3")?.size).toBe(1);
    offFirst();
    offFirst();
    expect(hubListeners.get("asm3")?.size).toBe(1);
    offSecond();
    expect(hubListeners.get("asm3")?.size).toBe(0);
    emitHub(liveChanged("asm3"));
    await flush();
    expect(loadPublicLiveState).not.toHaveBeenCalled();
  });

  it("hands nothing to a stream that closed while the state loaded", async () => {
    const load = deferred<LiveStatePushDto>();
    loadPublicLiveState.mockReturnValue(load.promise);
    const listener = vi.fn();
    const off = subscribeToLiveState("asm4", listener);
    emitHub(liveChanged("asm4"));
    off();
    load.resolve(push("2026-11-20T10:00:00.000Z"));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });
});

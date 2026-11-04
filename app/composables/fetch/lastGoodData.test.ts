import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computed,
  effectScope,
  nextTick,
  ref,
  watch,
  type EffectScope,
  type Ref,
} from "vue";
import {
  keepLastGoodData,
  useRetryFailed,
  type RetryableSource,
  type RetryFailedOptions,
} from "./lastGoodData";

interface Dto {
  id: string;
}

/** A stand-in for a Nuxt asyncData entry, writing in Nuxt's own order. */
function fakeAsyncData<T>(initial: T, fallback: T) {
  const data = ref(initial) as Ref<T>;
  const status = ref(initial === fallback ? "idle" : "success");
  const error = ref<unknown>(undefined);
  return {
    source: { data, status, error },
    start() {
      status.value = "pending";
    },
    succeed(value: T) {
      data.value = value;
      error.value = undefined;
      status.value = "success";
    },
    fail(statusCode?: number) {
      error.value = Object.assign(new Error("failed"), { statusCode });
      data.value = fallback;
      status.value = "error";
    },
  };
}

describe("keepLastGoodData", () => {
  it("keeps the last good value while refreshes fail", () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { data, stale } = keepLastGoodData(fake.source);

    fake.start();
    fake.fail(502);
    expect(data.value).toEqual({ id: "a" });
    expect(stale.value).toBe(true);

    // A retry in flight still shows the kept value.
    fake.start();
    expect(data.value).toEqual({ id: "a" });
    fake.fail();
    expect(data.value).toEqual({ id: "a" });

    fake.start();
    fake.succeed({ id: "b" });
    expect(data.value).toEqual({ id: "b" });
    expect(stale.value).toBe(false);
  });

  it("never lets a watcher see the reset value", async () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { data } = keepLastGoodData(fake.source);
    const seen: (string | undefined)[] = [];
    watch(
      () => data.value?.id,
      (id) => seen.push(id),
    );
    fake.start();
    fake.fail();
    await nextTick();
    expect(seen).toEqual([]);
  });

  it("never lets a sync watcher see the reset value", () => {
    // The hub keys the agenda on the kept assembly id, and Nuxt watches that
    // key synchronously: an instant of undefined would unregister the agenda
    // entry, abort it and refetch it under "none" and back.
    const hub = fakeAsyncData<Dto | undefined>({ id: "asm1" }, undefined);
    const { data: assembly } = keepLastGoodData(hub.source);
    const agendaKey = computed(
      () => `assembly-agenda-${assembly.value?.id ?? "none"}`,
    );
    const keys: string[] = [];
    watch(agendaKey, (key) => keys.push(key), { flush: "sync" });

    const agenda = fakeAsyncData<{ items: string[] } | undefined>(
      { items: ["a"] },
      undefined,
    );
    const { data: agendaData, stale: agendaStale } = keepLastGoodData(
      agenda.source,
      { resetOn: () => assembly.value?.id },
    );
    const seen: ({ items: string[] } | undefined)[] = [];
    watch(agendaData, (value) => seen.push(value), { flush: "sync" });

    // An outage: a poll refreshes both and both fail.
    hub.start();
    agenda.start();
    hub.fail(502);
    agenda.fail(502);

    expect(keys).toEqual([]);
    expect(assembly.value).toEqual({ id: "asm1" });
    expect(agendaData.value).toEqual({ items: ["a"] });
    expect(agendaStale.value).toBe(true);
    expect(seen).toEqual([]);

    // Back online: the new value shows once, with nothing in between.
    agenda.start();
    agenda.succeed({ items: ["b"] });
    expect(seen).toEqual([{ items: ["b"] }]);
    expect(agendaStale.value).toBe(false);
  });

  it("lets a sync watcher see a 404", () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { data, stale } = keepLastGoodData(fake.source);
    const seen: (string | undefined)[] = [];
    watch(
      () => data.value?.id,
      (id) => seen.push(id),
      { flush: "sync" },
    );
    fake.start();
    fake.fail(404);
    expect(seen).toEqual([undefined]);
    expect(stale.value).toBe(false);
  });

  it("lets a 404 through", () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { data, stale } = keepLastGoodData(fake.source);
    fake.start();
    fake.fail(404);
    expect(data.value).toBeUndefined();
    expect(stale.value).toBe(false);
  });

  it("uses a custom gone check", () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { data } = keepLastGoodData(fake.source, {
      isGone: (error) => (error as { statusCode?: number }).statusCode === 403,
    });
    fake.start();
    fake.fail(403);
    expect(data.value).toBeUndefined();
  });

  it("shows a successful null", () => {
    const fake = fakeAsyncData<Dto | null>({ id: "a" }, null);
    const { data } = keepLastGoodData(fake.source);
    fake.start();
    fake.succeed(null);
    expect(data.value).toBeNull();
    fake.start();
    fake.fail();
    expect(data.value).toBeNull();
  });

  it("forgets the kept value when the source changes", () => {
    const key = ref("doc-1");
    const fake = fakeAsyncData<Dto | undefined>({ id: "doc-1" }, undefined);
    const { data } = keepLastGoodData(fake.source, { resetOn: key });
    key.value = "doc-2";
    fake.start();
    fake.fail();
    expect(data.value).toBeUndefined();
  });

  it("writes through and counts writes as good", () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { data, stale } = keepLastGoodData(fake.source);
    fake.start();
    fake.fail();
    data.value = { id: "mutated" };
    expect(fake.source.data.value).toEqual({ id: "mutated" });
    expect(data.value).toEqual({ id: "mutated" });
    expect(stale.value).toBe(false);
  });

  it("takes writes made elsewhere to the same source", () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { data } = keepLastGoodData(fake.source);
    fake.start();
    fake.fail();
    // Another component sharing the fetch key stores a mutation response.
    fake.source.data.value = { id: "elsewhere" };
    expect(data.value).toEqual({ id: "elsewhere" });
  });

  it("starts stale-free when the first request failed", () => {
    const fake = fakeAsyncData<Dto | undefined>(undefined, undefined);
    fake.start();
    fake.fail(500);
    const { data, stale, failed } = keepLastGoodData(fake.source);
    expect(data.value).toBeUndefined();
    expect(stale.value).toBe(false);
    expect(failed.value).toBe(true);
    fake.start();
    fake.succeed({ id: "a" });
    expect(data.value).toEqual({ id: "a" });
    expect(stale.value).toBe(false);
    expect(failed.value).toBe(false);
  });

  it("is never stale while nothing good has arrived", () => {
    const fake = fakeAsyncData<Dto | undefined>(undefined, undefined);
    const { data, stale, failed } = keepLastGoodData(fake.source);
    // A poll keeps retrying a source that never loaded.
    fake.start();
    fake.fail(502);
    expect(stale.value).toBe(false);
    expect(failed.value).toBe(true);
    fake.start();
    fake.fail(502);
    expect(stale.value).toBe(false);
    expect(failed.value).toBe(true);
    expect(data.value).toBeUndefined();
  });

  it("flags a failure right after a source switch as stale", () => {
    const key = ref("doc-1");
    const fake = fakeAsyncData<Dto | undefined>({ id: "doc-1" }, undefined);
    const { data, stale, failed } = keepLastGoodData(fake.source, {
      resetOn: key,
    });
    key.value = "doc-2";
    fake.start();
    fake.fail(502);
    // Nothing of doc-2 to show, but the screen is not up to date.
    expect(data.value).toBeUndefined();
    expect(stale.value).toBe(true);
    expect(failed.value).toBe(true);
  });

  it("does not count a gone error as failed", () => {
    const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
    const { stale, failed } = keepLastGoodData(fake.source);
    fake.start();
    fake.fail(404);
    expect(stale.value).toBe(false);
    expect(failed.value).toBe(false);
  });
});

/** A wrapped fake whose refresh answers with the next scripted outcome. */
function retryableFake(outcomes: (number | "ok")[]) {
  const fake = fakeAsyncData<Dto | undefined>({ id: "a" }, undefined);
  const { data, failed } = keepLastGoodData(fake.source);
  const refresh = vi.fn(async () => {
    fake.start();
    await Promise.resolve();
    const next = outcomes.shift() ?? "ok";
    if (next === "ok") fake.succeed({ id: "fresh" });
    else fake.fail(next);
  });
  return {
    fake,
    data,
    failed,
    refresh,
    source: { failed, status: fake.source.status, refresh },
  };
}

describe("useRetryFailed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No jitter: every delay is exact.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function start(
    sources: RetryableSource[],
    options: RetryFailedOptions = {},
  ): EffectScope {
    const scope = effectScope();
    scope.run(() => useRetryFailed(sources, options));
    return scope;
  }

  it("retries with backoff until the source succeeds, then stops", async () => {
    const live = retryableFake([502, 502, "ok"]);
    const onRecovered = vi.fn();
    const scope = start([live.source], {
      baseDelay: 1_000,
      maxDelay: 3_000,
      onRecovered,
    });

    // A live refresh fails while the stream stays up.
    live.fake.start();
    live.fake.fail(502);

    await vi.advanceTimersByTimeAsync(999);
    expect(live.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(live.refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(live.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.refresh).toHaveBeenCalledTimes(2);

    // 4 s capped at 3 s.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(live.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.refresh).toHaveBeenCalledTimes(3);
    expect(live.data.value).toEqual({ id: "fresh" });
    expect(live.failed.value).toBe(false);
    expect(onRecovered).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.refresh).toHaveBeenCalledTimes(3);
    scope.stop();
  });

  it("only refreshes failed sources with no request in flight", async () => {
    const live = retryableFake(["ok"]);
    const document = retryableFake(["ok"]);
    const agenda = retryableFake([]);
    const scope = start([live.source, document.source, agenda.source], {
      baseDelay: 1_000,
    });

    live.fake.start();
    live.fake.fail(502);
    document.fake.start();
    document.fake.fail(502);
    // A live event refreshes the document again; still in flight.
    document.fake.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.refresh).toHaveBeenCalledTimes(1);
    expect(document.refresh).not.toHaveBeenCalled();
    expect(agenda.refresh).not.toHaveBeenCalled();

    // That request fails too: the next attempt picks it up.
    document.fake.fail(502);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(document.refresh).toHaveBeenCalledTimes(1);
    expect(document.failed.value).toBe(false);
    expect(agenda.refresh).not.toHaveBeenCalled();
    scope.stop();
  });

  it("retries a source that had already failed when it starts", async () => {
    const live = retryableFake(["ok"]);
    live.fake.start();
    live.fake.fail(502);
    const scope = start([live.source], { baseDelay: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.refresh).toHaveBeenCalledTimes(1);
    expect(live.failed.value).toBe(false);
    scope.stop();
  });

  it("stops once another refresh succeeds and starts over after", async () => {
    const live = retryableFake([502]);
    const scope = start([live.source], { baseDelay: 1_000 });

    live.fake.start();
    live.fake.fail(502);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.refresh).toHaveBeenCalledTimes(1);

    // A live event refreshes it successfully before the next attempt.
    live.fake.start();
    live.fake.succeed({ id: "b" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.refresh).toHaveBeenCalledTimes(1);

    // A later failure waits the base delay again, not the backed-off one.
    live.fake.start();
    live.fake.fail(502);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.refresh).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("never retries a gone source", async () => {
    const live = retryableFake([]);
    const scope = start([live.source], { baseDelay: 1_000 });
    live.fake.start();
    live.fake.fail(404);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.refresh).not.toHaveBeenCalled();
    scope.stop();
  });

  it("stops with its scope", async () => {
    const live = retryableFake([]);
    const scope = start([live.source], { baseDelay: 1_000 });
    live.fake.start();
    live.fake.fail(502);
    scope.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live.refresh).not.toHaveBeenCalled();
  });
});

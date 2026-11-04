import { describe, expect, it } from "vitest";
import { nextTick, ref, watch, type Ref } from "vue";
import { keepLastGoodData } from "./lastGoodData";

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

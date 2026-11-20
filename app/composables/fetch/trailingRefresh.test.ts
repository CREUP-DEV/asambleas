import { describe, expect, it } from "vitest";
import { trailingRefresh } from "./trailingRefresh";

/** A run that settles when the test says so. */
function controlledRun() {
  const settles: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let calls = 0;
  const run = () => {
    calls += 1;
    return new Promise<void>((resolve, reject) => {
      settles.push({ resolve, reject });
    });
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    run,
    flush,
    calls: () => calls,
    settle: (index: number) => settles[index]!.resolve(),
    fail: (index: number) => settles[index]!.reject(new Error("down")),
  };
}

describe("trailingRefresh", () => {
  it("runs at once when nothing is on its way", async () => {
    const control = controlledRun();
    const refresh = trailingRefresh(control.run);
    const done = refresh();
    await control.flush();
    expect(control.calls()).toBe(1);
    control.settle(0);
    await done;
    expect(control.calls()).toBe(1);
  });

  it("runs once more after the pending one, however many calls came", async () => {
    const control = controlledRun();
    const refresh = trailingRefresh(control.run);
    const first = refresh();
    await control.flush();
    const second = refresh();
    const third = refresh();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(control.calls()).toBe(1);
    control.settle(0);
    await control.flush();
    expect(control.calls()).toBe(2);
    control.settle(1);
    await first;
    expect(control.calls()).toBe(2);
  });

  it("starts afresh once the last run settled", async () => {
    const control = controlledRun();
    const refresh = trailingRefresh(control.run);
    const first = refresh();
    await control.flush();
    control.settle(0);
    await first;
    const next = refresh();
    expect(next).not.toBe(first);
    await control.flush();
    expect(control.calls()).toBe(2);
    control.settle(1);
    await next;
  });

  it("is never locked by a run that fails", async () => {
    const control = controlledRun();
    const refresh = trailingRefresh(control.run);
    const first = refresh();
    await control.flush();
    control.fail(0);
    await expect(first).resolves.toBeUndefined();
    const next = refresh();
    await control.flush();
    expect(control.calls()).toBe(2);
    control.settle(1);
    await next;
  });

  it("is never locked by a run that throws at once", async () => {
    let calls = 0;
    const refresh = trailingRefresh(() => {
      calls += 1;
      throw new Error("down");
    });
    await refresh();
    await refresh();
    expect(calls).toBe(2);
  });
});

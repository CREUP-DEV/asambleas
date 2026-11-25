import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { cancelStaleRead } from "./cancelStaleRead";

function fakeSource(status: string) {
  return {
    status: ref(status),
    refresh: vi.fn((_options: { dedupe: "cancel" }) => Promise.resolve()),
  };
}

describe("cancelStaleRead", () => {
  it("fetches nothing when no read is on its way", () => {
    for (const status of ["idle", "success", "error"]) {
      const source = fakeSource(status);
      cancelStaleRead(source, { isHydrating: () => false });
      expect(source.refresh).not.toHaveBeenCalled();
    }
  });

  it("replaces a read on its way by one that cancels it", () => {
    const source = fakeSource("pending");
    cancelStaleRead(source, { isHydrating: () => false });
    expect(source.refresh).toHaveBeenCalledTimes(1);
    expect(source.refresh).toHaveBeenCalledWith({ dedupe: "cancel" });
  });

  it("waits for the app to be ready while the page hydrates", () => {
    const source = fakeSource("pending");
    let ready: (() => void) | undefined;
    cancelStaleRead(source, {
      isHydrating: () => true,
      onReady: (run) => {
        ready = run;
      },
    });
    expect(source.refresh).not.toHaveBeenCalled();
    ready?.();
    expect(source.refresh).toHaveBeenCalledTimes(1);
    expect(source.refresh).toHaveBeenCalledWith({ dedupe: "cancel" });
  });

  it("does not wait when the page is not hydrating", () => {
    const source = fakeSource("pending");
    const onReady = vi.fn();
    cancelStaleRead(source, { isHydrating: () => false, onReady });
    expect(onReady).not.toHaveBeenCalled();
    expect(source.refresh).toHaveBeenCalledTimes(1);
  });
});

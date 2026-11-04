import { describe, expect, it } from "vitest";
import { msUntilNextMinute } from "./useAppNow";

describe("msUntilNextMinute", () => {
  it("lands just after the next minute boundary", () => {
    const start = Date.UTC(2026, 10, 14, 9, 30, 0);
    expect(msUntilNextMinute(start)).toBe(60_050);
    expect(msUntilNextMinute(start + 15_000)).toBe(45_050);
    expect(msUntilNextMinute(start + 59_999)).toBe(51);
  });

  it("never ticks twice within the same minute", () => {
    const now = Date.UTC(2026, 10, 14, 9, 30, 20);
    const next = now + msUntilNextMinute(now);
    expect(new Date(next).getUTCMinutes()).toBe(31);
    // A tick that lands 50 ms late still schedules the following minute.
    expect(new Date(next + msUntilNextMinute(next)).getUTCMinutes()).toBe(32);
  });
});

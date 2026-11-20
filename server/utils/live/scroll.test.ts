import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTallyDto } from "~~/shared/types/api";
import { LIVE_TALLY_TTL_MS } from "~~/shared/utils/schemas/assembly";
import { CONTROL_TTL_MS } from "./projectionControl";
import {
  clearLiveScrollForTests,
  endLiveTally,
  publishLiveTally,
  readLiveTally,
  subscribeToLiveTally,
  takeLiveTallyTicket,
} from "./scroll";

const counting: LiveTallyDto = {
  tally: {
    subject: { type: "amendment", id: "a1" },
    question: null,
    method: "secret",
    reveal: "end",
    counts: null,
    present: 30,
    majority: "simple",
  },
  at: "2026-11-19T10:00:00.000Z",
};

afterEach(() => {
  clearLiveScrollForTests();
  vi.useRealTimers();
});

describe("live tally", () => {
  it("keeps the last announcement and ends it with null", () => {
    const seen: LiveTallyDto[] = [];
    subscribeToLiveTally("as1", (tally) => seen.push(tally));
    publishLiveTally("as1", counting);
    expect(readLiveTally("as1")).toEqual(counting);
    publishLiveTally("as1", { tally: null, at: counting.at });
    expect(readLiveTally("as1")).toBeNull();
    expect(seen.map((entry) => entry.tally)).toEqual([counting.tally, null]);
  });
});

describe("endLiveTally", () => {
  it("forgets the kept count without telling the streams", () => {
    const seen: LiveTallyDto[] = [];
    subscribeToLiveTally("as1", (tally) => seen.push(tally));
    publishLiveTally("as1", counting);
    publishLiveTally("as2", counting);
    endLiveTally("as1");
    expect(readLiveTally("as1")).toBeNull();
    expect(readLiveTally("as2")).toEqual(counting);
    expect(seen.map((entry) => entry.tally)).toEqual([counting.tally]);
  });
});

describe("live tally expiry", () => {
  it("outlasts a hidden console's repeat, as projection control does", () => {
    expect(LIVE_TALLY_TTL_MS).toBeGreaterThanOrEqual(CONTROL_TTL_MS);
  });

  it("ends a count nobody repeats and tells the streams", () => {
    vi.useFakeTimers();
    const seen: LiveTallyDto[] = [];
    subscribeToLiveTally("as1", (tally) => seen.push(tally));
    publishLiveTally("as1", counting);
    vi.advanceTimersByTime(LIVE_TALLY_TTL_MS - 1);
    expect(readLiveTally("as1")).toEqual(counting);
    vi.advanceTimersByTime(1);
    expect(readLiveTally("as1")).toBeNull();
    expect(seen.map((entry) => entry.tally)).toEqual([counting.tally, null]);
  });

  it("restarts the wait on each repeat", () => {
    vi.useFakeTimers();
    publishLiveTally("as1", counting);
    vi.advanceTimersByTime(LIVE_TALLY_TTL_MS - 1000);
    publishLiveTally("as1", counting);
    vi.advanceTimersByTime(LIVE_TALLY_TTL_MS - 1000);
    expect(readLiveTally("as1")).toEqual(counting);
    vi.advanceTimersByTime(1000);
    expect(readLiveTally("as1")).toBeNull();
  });

  it("sends nothing more once ended or projected", () => {
    vi.useFakeTimers();
    const seen: LiveTallyDto[] = [];
    subscribeToLiveTally("as1", (tally) => seen.push(tally));
    publishLiveTally("as1", counting);
    publishLiveTally("as1", { tally: null, at: counting.at });
    publishLiveTally("as2", counting);
    endLiveTally("as2");
    vi.advanceTimersByTime(LIVE_TALLY_TTL_MS * 2);
    expect(seen.map((entry) => entry.tally)).toEqual([counting.tally, null]);
  });
});

describe("live tally order", () => {
  it("drops a push that arrived before one already published", () => {
    const seen: LiveTallyDto[] = [];
    subscribeToLiveTally("as1", (tally) => seen.push(tally));
    const late = takeLiveTallyTicket();
    const end = takeLiveTallyTicket();
    expect(publishLiveTally("as1", { tally: null, at: counting.at }, end)).toBe(
      true,
    );
    expect(publishLiveTally("as1", counting, late)).toBe(false);
    expect(readLiveTally("as1")).toBeNull();
    expect(seen.map((entry) => entry.tally)).toEqual([null]);
  });

  it("keeps the order per assembly", () => {
    const first = takeLiveTallyTicket();
    const second = takeLiveTallyTicket();
    expect(publishLiveTally("as1", counting, second)).toBe(true);
    expect(publishLiveTally("as2", counting, first)).toBe(true);
    expect(readLiveTally("as2")).toEqual(counting);
  });
});

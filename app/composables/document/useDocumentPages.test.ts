import { describe, expect, it } from "vitest";
import {
  documentPagesTarget,
  pagesAskDelay,
  pagesRetryDelay,
} from "./useDocumentPages";

type Input = NonNullable<Parameters<typeof documentPagesTarget>[1]>;

function doc(overrides: Partial<Input> = {}): Input {
  return {
    id: "doc-1",
    status: "published",
    format: "structured",
    title: "Reglamento",
    kind: "regulation",
    baseVersion: { id: "v-base" },
    consolidatedVersion: null,
    finalVote: null,
    ...overrides,
  } as Input;
}

describe("documentPagesTarget", () => {
  it("reads a published or postponed text", () => {
    expect(documentPagesTarget("ago", doc())?.document).toBe("doc-1");
    expect(
      documentPagesTarget("ago", doc({ status: "postponed" }))?.document,
    ).toBe("doc-1");
  });

  it("reads nothing for a text that is not public", () => {
    for (const status of ["draft", "submitted", "withdrawn"] as const) {
      expect(documentPagesTarget("ago", doc({ status }))).toBeNull();
    }
  });

  it("reads nothing for an uploaded PDF or a text without version", () => {
    expect(documentPagesTarget("ago", doc({ format: "file" }))).toBeNull();
    expect(documentPagesTarget("ago", doc({ baseVersion: null }))).toBeNull();
  });
});

describe("pagesRetryDelay", () => {
  function schedule(): number[] {
    const delays: number[] = [];
    for (let tries = 0; ; tries += 1) {
      const delay = pagesRetryDelay(tries);
      if (delay === null) return delays;
      delays.push(delay);
    }
  }

  it("asks further apart, up to a minute", () => {
    const delays = schedule();
    expect(delays.slice(0, 4)).toEqual([20_000, 40_000, 60_000, 60_000]);
    expect(Math.max(...delays)).toBe(60_000);
  });

  it("keeps asking past the job's wait and the server's requeue", () => {
    const total = schedule().reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThan(10 * 60_000);
    expect(total).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe("pagesAskDelay", () => {
  it("follows the schedule when the server suggests nothing", () => {
    expect(pagesAskDelay({ tries: 0, waited: 0, random: 0 })).toBe(20_000);
    expect(pagesAskDelay({ tries: 2, waited: 60_000, random: 0 })).toBe(60_000);
  });

  it("waits what the server's retryAfter says, in seconds", () => {
    expect(
      pagesAskDelay({ tries: 0, waited: 0, retryAfter: 180, random: 0 }),
    ).toBe(180_000);
    // Never sooner than the schedule's wait for that ask.
    expect(
      pagesAskDelay({ tries: 0, waited: 0, retryAfter: 1, random: 0 }),
    ).toBe(20_000);
    expect(
      pagesAskDelay({
        tries: 20,
        waited: 5 * 60_000,
        retryAfter: 30,
        random: 0,
      }),
    ).toBe(60_000);
  });

  it("keeps asking through the window while the server says when", () => {
    // Only the window stops it, not how many asks the schedule fits.
    expect(
      pagesAskDelay({ tries: 100, waited: 0, retryAfter: 5, random: 0 }),
    ).toBe(60_000);
    expect(
      pagesAskDelay({
        tries: 100,
        waited: 14.5 * 60_000,
        retryAfter: 5,
        random: 0,
      }),
    ).toBeNull();
  });

  it("ignores a retryAfter that is not a positive number", () => {
    for (const retryAfter of [0, -5, Number.NaN, Infinity, "30", null]) {
      expect(
        pagesAskDelay({ tries: 0, waited: 0, retryAfter, random: 0 }),
      ).toBe(20_000);
    }
  });

  it("spreads the readers by up to a quarter of the wait", () => {
    expect(pagesAskDelay({ tries: 0, waited: 0, random: 1 })).toBe(25_000);
    expect(pagesAskDelay({ tries: 0, waited: 0, random: 0.5 })).toBe(22_500);
    expect(pagesAskDelay({ tries: 0, waited: 0, random: 7 })).toBe(25_000);
  });

  it("stops once the next ask would fall past the window", () => {
    expect(
      pagesAskDelay({ tries: 2, waited: 14.5 * 60_000, random: 0 }),
    ).toBeNull();
    // The jitter counts too.
    expect(pagesAskDelay({ tries: 2, waited: 14 * 60_000, random: 0 })).toBe(
      60_000,
    );
    expect(
      pagesAskDelay({ tries: 2, waited: 14 * 60_000, random: 1 }),
    ).toBeNull();
    // A server that keeps saying «later» does not stretch the window.
    expect(
      pagesAskDelay({
        tries: 3,
        waited: 13 * 60_000,
        retryAfter: 180,
        random: 0,
      }),
    ).toBeNull();
    // Without a retryAfter, the schedule's asks run out with the window.
    expect(pagesAskDelay({ tries: 100, waited: 0, random: 0 })).toBeNull();
  });
});

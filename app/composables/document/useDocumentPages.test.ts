import { describe, expect, it } from "vitest";
import { documentPagesTarget, pagesRetryDelay } from "./useDocumentPages";

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

import { describe, expect, it } from "vitest";
import {
  PAGES_RETRY_AFTER_MIN_S,
  pagesJobStartAfter,
  pagesRetryAfter,
  PREBUILD_DELAY_MS,
} from "./prebuild";

describe("pagesJobStartAfter", () => {
  it("waits past the prebuild in a convened or sitting assembly", () => {
    for (const status of ["convened", "in_session"]) {
      const seconds = pagesJobStartAfter(status);
      expect(seconds).toBeDefined();
      expect(seconds! * 1000).toBeGreaterThan(PREBUILD_DELAY_MS);
    }
  });

  it("runs at once where nothing is built ahead", () => {
    for (const status of ["draft", "closed"]) {
      expect(pagesJobStartAfter(status)).toBeUndefined();
    }
  });
});

describe("pagesRetryAfter", () => {
  const queuedAt = 1_000_000;

  it("answers what is left of the job's startAfter", () => {
    expect(pagesRetryAfter(queuedAt, 180, queuedAt)).toBe(180);
    expect(pagesRetryAfter(queuedAt, 180, queuedAt + 60_000)).toBe(120);
    // Part of a second left counts as a whole one.
    expect(pagesRetryAfter(queuedAt, 180, queuedAt + 60_500)).toBe(120);
  });

  it("never answers under the floor", () => {
    expect(pagesRetryAfter(queuedAt, 180, queuedAt + 178_000)).toBe(
      PAGES_RETRY_AFTER_MIN_S,
    );
    expect(pagesRetryAfter(queuedAt, 180, queuedAt + 600_000)).toBe(
      PAGES_RETRY_AFTER_MIN_S,
    );
  });

  it("answers the floor for a job that runs at once", () => {
    expect(pagesRetryAfter(queuedAt, undefined, queuedAt)).toBe(
      PAGES_RETRY_AFTER_MIN_S,
    );
  });

  it("answers the whole wait of a job queued now in a sitting assembly", () => {
    const startAfter = pagesJobStartAfter("in_session");
    expect(pagesRetryAfter(queuedAt, startAfter, queuedAt)).toBe(startAfter);
  });
});

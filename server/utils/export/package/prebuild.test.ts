import { describe, expect, it } from "vitest";
import { pagesJobStartAfter, PREBUILD_DELAY_MS } from "./prebuild";

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

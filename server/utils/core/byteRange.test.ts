import { describe, expect, it } from "vitest";
import { resolveByteRange } from "./byteRange";

const ETAG = '"64-18c"';
const SIZE = 100;

describe("resolveByteRange", () => {
  it("sends the whole file without a Range", () => {
    expect(resolveByteRange(undefined, SIZE, undefined, ETAG)).toEqual({
      kind: "full",
    });
  });

  it("serves one range, cut at the end of the file", () => {
    expect(resolveByteRange("bytes=0-9", SIZE, undefined, ETAG)).toEqual({
      kind: "partial",
      start: 0,
      end: 9,
    });
    expect(resolveByteRange("bytes=90-500", SIZE, undefined, ETAG)).toEqual({
      kind: "partial",
      start: 90,
      end: 99,
    });
  });

  it("serves an open-ended range to the end", () => {
    expect(resolveByteRange("bytes=40-", SIZE, undefined, ETAG)).toEqual({
      kind: "partial",
      start: 40,
      end: 99,
    });
  });

  it("serves the last N bytes of a suffix range", () => {
    expect(resolveByteRange("bytes=-10", SIZE, undefined, ETAG)).toEqual({
      kind: "partial",
      start: 90,
      end: 99,
    });
    expect(resolveByteRange("bytes=-500", SIZE, undefined, ETAG)).toEqual({
      kind: "partial",
      start: 0,
      end: 99,
    });
  });

  it("answers 416 for a range past the end or an empty suffix", () => {
    expect(resolveByteRange("bytes=100-", SIZE, undefined, ETAG)).toEqual({
      kind: "unsatisfiable",
    });
    expect(resolveByteRange("bytes=-0", SIZE, undefined, ETAG)).toEqual({
      kind: "unsatisfiable",
    });
  });

  it("ignores what it does not serve: several ranges, another unit, junk", () => {
    for (const header of [
      "bytes=0-9,20-29",
      "items=0-9",
      "bytes=9-0",
      "bytes=-",
      "bytes=a-b",
    ]) {
      expect(resolveByteRange(header, SIZE, undefined, ETAG)).toEqual({
        kind: "full",
      });
    }
  });

  it("honours If-Range only with the current ETag", () => {
    expect(resolveByteRange("bytes=0-9", SIZE, ETAG, ETAG)).toEqual({
      kind: "partial",
      start: 0,
      end: 9,
    });
    for (const ifRange of [
      '"other"',
      `W/${ETAG}`,
      "Tue, 24 Nov 2026 10:00:00 GMT",
    ]) {
      expect(resolveByteRange("bytes=0-9", SIZE, ifRange, ETAG)).toEqual({
        kind: "full",
      });
    }
  });
});

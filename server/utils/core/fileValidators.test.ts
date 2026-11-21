import { describe, expect, it } from "vitest";
import { etagMatches, fileEtag } from "./fileValidators";

describe("fileEtag", () => {
  it("names the file by its size and its last change", () => {
    expect(fileEtag({ size: 255, mtimeMs: 4096.7 })).toBe('"ff-1000"');
  });

  it("changes when either changes", () => {
    const base = fileEtag({ size: 10, mtimeMs: 1000 });
    expect(fileEtag({ size: 11, mtimeMs: 1000 })).not.toBe(base);
    expect(fileEtag({ size: 10, mtimeMs: 2000 })).not.toBe(base);
  });
});

describe("etagMatches", () => {
  const etag = '"ff-1000"';

  it("matches the same tag, alone or in a list", () => {
    expect(etagMatches('"ff-1000"', etag)).toBe(true);
    expect(etagMatches('"aa-1", "ff-1000"', etag)).toBe(true);
  });

  it("ignores a weak prefix (a proxy that compressed the answer)", () => {
    expect(etagMatches('W/"ff-1000"', etag)).toBe(true);
  });

  it("matches any tag for *", () => {
    expect(etagMatches(" * ", etag)).toBe(true);
  });

  it("does not match another tag or no header", () => {
    expect(etagMatches('"ff-1001"', etag)).toBe(false);
    expect(etagMatches("", etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });
});

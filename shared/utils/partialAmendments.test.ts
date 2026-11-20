import { describe, expect, it } from "vitest";
import {
  parseAmendmentIdsQuery,
  PARTIAL_AMENDMENTS_MAX,
} from "./partialAmendments";

describe("parseAmendmentIdsQuery", () => {
  it("is undefined without the parameter: the whole list", () => {
    expect(parseAmendmentIdsQuery(undefined)).toBeUndefined();
  });

  it("reads comma-separated ids, trimmed and without repeats", () => {
    expect(parseAmendmentIdsQuery("a1, b2 ,a1,,c_3-x")).toEqual([
      "a1",
      "b2",
      "c_3-x",
    ]);
  });

  it("reads a repeated parameter too", () => {
    expect(parseAmendmentIdsQuery(["a1,b2", "c3"])).toEqual(["a1", "b2", "c3"]);
  });

  it("takes up to the cap", () => {
    const ids = Array.from(
      { length: PARTIAL_AMENDMENTS_MAX },
      (_, i) => `a${i}`,
    );
    expect(parseAmendmentIdsQuery(ids.join(","))).toEqual(ids);
  });

  it("refuses more than the cap", () => {
    const ids = Array.from(
      { length: PARTIAL_AMENDMENTS_MAX + 1 },
      (_, i) => `a${i}`,
    );
    expect(parseAmendmentIdsQuery(ids.join(","))).toBeNull();
  });

  it("refuses an empty or malformed parameter", () => {
    expect(parseAmendmentIdsQuery("")).toBeNull();
    expect(parseAmendmentIdsQuery(" , ")).toBeNull();
    expect(parseAmendmentIdsQuery("a1,b 2")).toBeNull();
    expect(parseAmendmentIdsQuery("a1;drop")).toBeNull();
    expect(parseAmendmentIdsQuery("x".repeat(65))).toBeNull();
    expect(parseAmendmentIdsQuery(42)).toBeNull();
    expect(parseAmendmentIdsQuery(["a1", 3])).toBeNull();
    expect(parseAmendmentIdsQuery({ a: "1" })).toBeNull();
  });
});

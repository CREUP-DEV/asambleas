import { describe, expect, it } from "vitest";
import {
  goneAmendmentIds,
  linkedAmendmentIds,
  type LinkedAmendmentRow,
} from "./amendmentDependencies";

const row = (
  id: string,
  sources: string[] = [],
  derived: string[] = [],
): LinkedAmendmentRow => ({
  id,
  sources: sources.map((sourceId) => ({ sourceId })),
  derived: derived.map((transactionalId) => ({ transactionalId })),
});

describe("linkedAmendmentIds", () => {
  it("adds the transactionals over an amendment", () => {
    // A decided source changes whether T1 and T2 can still go through.
    expect(linkedAmendmentIds([row("s1", [], ["t1", "t2"])])).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("adds what a transactional groups", () => {
    expect(linkedAmendmentIds([row("t1", ["s1", "s2"])])).toEqual(["s1", "s2"]);
  });

  it("adds both for a transactional over another", () => {
    expect(linkedAmendmentIds([row("t1", ["s1"], ["t2"])])).toEqual([
      "s1",
      "t2",
    ]);
  });

  it("leaves out the rows themselves and repeats", () => {
    expect(
      linkedAmendmentIds([
        row("t1", ["s1", "s2"]),
        row("s1", [], ["t1", "t3"]),
        row("s2", [], ["t1", "t3"]),
      ]),
    ).toEqual(["t3"]);
  });

  it("adds the extra ids not among the rows", () => {
    expect(linkedAmendmentIds([row("t1", ["s1"])], ["s1", "s9", "t1"])).toEqual(
      ["s1", "s9"],
    );
  });

  it("is empty for an amendment with no links", () => {
    expect(linkedAmendmentIds([row("a")])).toEqual([]);
    expect(linkedAmendmentIds([])).toEqual([]);
  });
});

describe("goneAmendmentIds", () => {
  it("lists the asked ids not sent, once each", () => {
    expect(goneAmendmentIds(["a", "b", "t1", "a", "x"], ["a", "t1"])).toEqual([
      "b",
      "x",
    ]);
  });

  it("is empty when everything was sent", () => {
    expect(goneAmendmentIds(["a"], ["a", "b"])).toEqual([]);
  });
});

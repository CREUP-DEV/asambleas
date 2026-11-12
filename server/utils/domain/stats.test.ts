import { describe, expect, it } from "vitest";
import { mergeViews, readsMore, tallyOpening, tallyReading } from "./stats";

const at = (day: number) => new Date(Date.UTC(2026, 10, day));

describe("tallyReading", () => {
  const documents = [
    { id: "d1", revision: "r1", presenters: ["m1"] },
    { id: "d2", revision: "r2", presenters: ["m2"] },
    { id: "d3", revision: "r3", presenters: ["m2", "m3"] },
  ];
  const amendments = [
    { id: "a1", revision: "x1", authors: ["m1"] },
    { id: "a2", revision: "x2", authors: ["m3"] },
  ];

  it("counts read and changed marks, leaving out what the member presents", () => {
    const reading = tallyReading({
      memberId: "m1",
      documents,
      amendments,
      documentMarks: new Map([
        ["d1", { revision: "r1", readAt: at(1) }],
        ["d2", { revision: "r2", readAt: at(2) }],
        ["d3", { revision: "old", readAt: at(3) }],
      ]),
      amendmentMarks: new Map([["a2", { revision: "x2", readAt: at(4) }]]),
    });
    expect(reading).toEqual({
      documents: 2,
      documentsRead: 1,
      documentsChanged: 1,
      amendments: 1,
      amendmentsRead: 1,
      amendmentsChanged: 0,
      lastReadAt: at(4).toISOString(),
    });
  });

  it("counts everything for an account without a member", () => {
    const reading = tallyReading({
      memberId: null,
      documents,
      amendments,
      documentMarks: undefined,
      amendmentMarks: undefined,
    });
    expect(reading.documents).toBe(3);
    expect(reading.amendments).toBe(2);
    expect(reading.documentsRead).toBe(0);
    expect(reading.lastReadAt).toBeNull();
  });
});

describe("readsMore", () => {
  const base = {
    documents: 5,
    documentsRead: 2,
    documentsChanged: 0,
    amendments: 5,
    amendmentsRead: 1,
    amendmentsChanged: 0,
    lastReadAt: null,
  };

  it("weighs documents first, then amendments", () => {
    expect(readsMore({ ...base, documentsRead: 3 }, base)).toBe(true);
    expect(readsMore({ ...base, amendmentsRead: 2 }, base)).toBe(true);
    expect(readsMore(base, base)).toBe(false);
    expect(
      readsMore({ ...base, documentsRead: 1, amendmentsRead: 5 }, base),
    ).toBe(false);
  });
});

describe("tallyOpening", () => {
  const documents = [
    { id: "d1", presenters: ["m1"] },
    { id: "d2", presenters: ["m2"] },
    { id: "d3", presenters: ["m3"] },
  ];
  const view = (views: number, seconds: number, day: number) => ({
    views,
    seconds,
    first: at(day),
    last: at(day),
  });

  it("counts what the member opened, and every second, its own included", () => {
    const opening = tallyOpening({
      memberId: "m1",
      documents,
      views: new Map([
        ["d1", view(2, 300, 1)],
        ["d2", view(1, 90, 3)],
      ]),
    });
    expect(opening).toEqual({
      documents: 2,
      opened: 1,
      views: 3,
      seconds: 390,
      lastOpenedAt: at(3).toISOString(),
    });
  });

  it("merges the accounts of a member", () => {
    const merged = new Map();
    mergeViews(merged, new Map([["d2", view(1, 60, 2)]]));
    mergeViews(
      merged,
      new Map([
        ["d2", view(2, 30, 4)],
        ["d3", view(1, 10, 1)],
      ]),
    );
    expect(merged.get("d2")).toEqual({
      views: 3,
      seconds: 90,
      first: at(2),
      last: at(4),
    });
    expect(
      tallyOpening({ memberId: "m1", documents, views: merged }).opened,
    ).toBe(2);
  });
});

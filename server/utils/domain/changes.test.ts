import { describe, expect, it } from "vitest";
import {
  CHANGE_TEXT_MAX_LENGTH,
  agendaSubtreeEntries,
  diffChanges,
  normalizeChangeValue,
  sortedIds,
  truncateChangeText,
} from "./changes";

describe("diffChanges", () => {
  it("returns only the fields whose value changed", () => {
    expect(
      diffChanges(
        { title: "Old", location: "Madrid", number: 80 },
        { title: "New", location: "Madrid", number: 80 },
      ),
    ).toEqual({ title: { from: "Old", to: "New" } });
  });

  it("returns an empty object when nothing differs", () => {
    expect(diffChanges({ a: 1, b: "x" }, { a: 1, b: "x" })).toEqual({});
    expect(diffChanges({ a: 1 }, {})).toEqual({});
  });

  it("skips fields left undefined but records a cleared field", () => {
    expect(
      diffChanges(
        { summary: "Text", dueAt: new Date("2026-01-01T00:00:00Z") },
        { summary: undefined, dueAt: null },
      ),
    ).toEqual({ dueAt: { from: "2026-01-01T00:00:00.000Z", to: null } });
  });

  it("reads a missing before value as null", () => {
    expect(diffChanges({}, { note: "Hola" })).toEqual({
      note: { from: null, to: "Hola" },
    });
    expect(diffChanges({}, { note: null })).toEqual({});
  });

  it("turns dates into ISO strings and compares them by instant", () => {
    const before = { startDate: new Date("2026-03-01T09:00:00.000Z") };
    expect(
      diffChanges(before, { startDate: new Date("2026-03-01T09:00:00Z") }),
    ).toEqual({});
    expect(
      diffChanges(before, { startDate: new Date("2026-03-02T09:00:00Z") }),
    ).toEqual({
      startDate: {
        from: "2026-03-01T09:00:00.000Z",
        to: "2026-03-02T09:00:00.000Z",
      },
    });
  });

  it("keeps booleans, numbers and enums as they are", () => {
    expect(
      diffChanges(
        { amendable: true, number: 80, majority: "simple" },
        { amendable: false, number: 81, majority: "absolute" },
      ),
    ).toEqual({
      amendable: { from: true, to: false },
      number: { from: 80, to: 81 },
      majority: { from: "simple", to: "absolute" },
    });
  });

  it("compares arrays element by element", () => {
    expect(diffChanges({ ids: ["a", "b"] }, { ids: ["a", "b"] })).toEqual({});
    expect(diffChanges({ ids: ["a", "b"] }, { ids: ["b", "a"] })).toEqual({
      ids: { from: ["a", "b"], to: ["b", "a"] },
    });
    expect(diffChanges({ ids: ["a"] }, { ids: ["a", "c"] })).toEqual({
      ids: { from: ["a"], to: ["a", "c"] },
    });
    expect(diffChanges({ ids: null }, { ids: [] })).toEqual({
      ids: { from: null, to: [] },
    });
  });

  it("limits the comparison to the given keys", () => {
    expect(
      diffChanges(
        { title: "A", order: 1, updatedAt: new Date(0) },
        { title: "B", order: 2, updatedAt: new Date(1) },
        { keys: ["title"] },
      ),
    ).toEqual({ title: { from: "A", to: "B" } });
  });

  it("prefixes keys, as for settings", () => {
    expect(
      diffChanges(
        {
          positionVisibility: "session",
          tieRule: "rejected",
          denominator: "valid_votes",
        },
        {
          positionVisibility: "public",
          tieRule: "rejected",
          denominator: "valid_votes",
        },
        { prefix: "settings." },
      ),
    ).toEqual({
      "settings.positionVisibility": { from: "session", to: "public" },
    });
  });

  it("cuts long texts but still sees a change past the cut", () => {
    const base = "a".repeat(CHANGE_TEXT_MAX_LENGTH + 100);
    const changes = diffChanges({ intro: base }, { intro: `${base}b` });
    const change = changes.intro!;
    expect(change).toBeDefined();
    expect(change.from).toBe(truncateChangeText(base));
    expect((change.to as string).length).toBe(CHANGE_TEXT_MAX_LENGTH);
    expect((change.to as string).endsWith("…")).toBe(true);
  });

  it("honours a custom text cap", () => {
    expect(
      diffChanges(
        { title: "short" },
        { title: "a much longer title" },
        { maxTextLength: 5 },
      ),
    ).toEqual({ title: { from: "short", to: "a mu…" } });
  });

  it("serializes stray objects stably instead of failing", () => {
    expect(
      diffChanges({ meta: { b: 1, a: 2 } }, { meta: { a: 2, b: 1 } }),
    ).toEqual({});
    expect(diffChanges({ meta: { a: 1 } }, { meta: { a: 2 } })).toEqual({
      meta: { from: '{"a":1}', to: '{"a":2}' },
    });
  });
});

describe("normalizeChangeValue", () => {
  it("maps undefined and invalid dates to null", () => {
    expect(normalizeChangeValue(undefined)).toBeNull();
    expect(normalizeChangeValue(new Date("nope"))).toBeNull();
  });

  it("normalizes the entries of arrays", () => {
    expect(
      normalizeChangeValue([new Date("2026-01-01T00:00:00Z"), "x", 1, null]),
    ).toEqual(["2026-01-01T00:00:00.000Z", "x", 1, null]);
  });
});

describe("truncateChangeText", () => {
  it("leaves short texts alone", () => {
    expect(truncateChangeText("hola", 4)).toBe("hola");
  });

  it("cuts by characters, never inside a surrogate pair", () => {
    expect(truncateChangeText("😀😀😀😀", 3)).toBe("😀😀…");
  });
});

describe("sortedIds", () => {
  it("returns a sorted copy and accepts null", () => {
    const ids = ["c", "a", "b"];
    expect(sortedIds(ids)).toEqual(["a", "b", "c"]);
    expect(ids).toEqual(["c", "a", "b"]);
    expect(sortedIds(null)).toEqual([]);
  });
});

describe("agendaSubtreeEntries", () => {
  const items = [
    { id: "r1", parentId: null, title: "Root 1" },
    { id: "r2", parentId: null, title: "Root 2" },
    { id: "c1", parentId: "r1", title: "Child 1" },
    { id: "c2", parentId: "r1", title: "Child 2" },
    { id: "g1", parentId: "c1", title: "Grandchild" },
    { id: "x", parentId: "r2", title: "Other" },
  ];

  it("lists the item and its descendants in display order", () => {
    expect(agendaSubtreeEntries(items, "r1")).toEqual([
      { id: "r1", title: "Root 1" },
      { id: "c1", title: "Child 1" },
      { id: "g1", title: "Grandchild" },
      { id: "c2", title: "Child 2" },
    ]);
  });

  it("lists a leaf alone", () => {
    expect(agendaSubtreeEntries(items, "g1")).toEqual([
      { id: "g1", title: "Grandchild" },
    ]);
  });

  it("is empty when the root is missing", () => {
    expect(agendaSubtreeEntries(items, "missing")).toEqual([]);
  });

  it("stops on a cycle", () => {
    expect(
      agendaSubtreeEntries(
        [
          { id: "a", parentId: "b", title: "A" },
          { id: "b", parentId: "a", title: "B" },
        ],
        "a",
      ),
    ).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
  });
});

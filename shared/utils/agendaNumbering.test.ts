import { describe, expect, it } from "vitest";
import {
  agendaChildGroups,
  numberAgendaItems,
  unlistedAgendaItemIds,
  type AgendaOrderItem,
} from "./agendaNumbering";
import { visibleAgendaItems } from "./agendaSubmissions";

const row = (
  id: string,
  parentId: string | null,
  order: number,
  unlisted = false,
): AgendaOrderItem => ({
  id,
  parentId,
  order,
  ...(unlisted ? { unlisted } : {}),
});

const numbersOf = (items: AgendaOrderItem[]) =>
  Object.fromEntries(numberAgendaItems(items));

describe("numberAgendaItems", () => {
  it("numbers items by their place among their siblings", () => {
    expect(
      numbersOf([
        row("b", null, 1),
        row("a", null, 0),
        row("a2", "a", 1),
        row("a1", "a", 0),
        row("a1x", "a1", 0),
      ]),
    ).toEqual({ a: "1", a1: "1.1", a1x: "1.1.1", a2: "1.2", b: "2" });
  });

  it("gives an unlisted item no number and never shifts its siblings", () => {
    // What the Secretaría gets: a draft before a published resolution.
    expect(
      numbersOf([
        row("r", null, 16),
        row("draft", "r", 0, true),
        row("published", "r", 1),
        row("submitted", "r", 2, true),
        row("other", "r", 3),
        row("s", null, 17),
      ]),
    ).toEqual({
      r: "1",
      draft: null,
      published: "1.1",
      submitted: null,
      other: "1.2",
      s: "2",
    });
  });

  it("reads the same numbers with and without the unlisted items", () => {
    const all = [
      row("r", null, 0),
      row("u1", "r", 0, true),
      row("a", "r", 1),
      row("u2", "r", 2, true),
      row("u2x", "u2", 0, true),
      row("b", "r", 3),
      row("u3", null, 1, true),
      row("s", null, 2),
      row("s1", "s", 0),
    ];
    const everyone = all.filter((item) => !item.unlisted);
    const full = numberAgendaItems(all);
    for (const [id, number] of numberAgendaItems(everyone)) {
      expect(full.get(id)).toBe(number);
    }
    // No gaps in what anyone reads.
    expect(everyone.map((item) => full.get(item.id)).sort()).toEqual([
      "1",
      "1.1",
      "1.2",
      "2",
      "2.1",
    ]);
  });

  it("gives no number to anything under an item without one", () => {
    expect(
      numbersOf([
        row("r", null, 0),
        row("u", "r", 0, true),
        row("ux", "u", 0, true),
        row("uy", "u", 1),
        row("uyz", "uy", 0),
      ]),
    ).toEqual({ r: "1", u: null, ux: null, uy: null, uyz: null });
  });

  it("numbers nothing when every item is unlisted", () => {
    expect(
      numbersOf([row("a", null, 0, true), row("b", null, 1, true)]),
    ).toEqual({ a: null, b: null });
    expect(numbersOf([])).toEqual({});
  });

  it("does not depend on the order the items come in", () => {
    const items = [
      row("r", null, 0),
      row("u", "r", 0, true),
      row("a", "r", 1),
      row("b", "r", 1),
      row("s", null, 1),
    ];
    const expected = numbersOf(items);
    expect(expected).toMatchObject({ a: "1.1", b: "1.2", s: "2" });
    expect(numbersOf([...items].reverse())).toEqual(expected);
    // Never mutates its input.
    expect(items.map((item) => item.id)).toEqual(["r", "u", "a", "b", "s"]);
  });

  it("treats a missing parent and a parent cycle as roots", () => {
    expect(
      numbersOf([
        row("a", "b", 0),
        row("b", "a", 1),
        row("c", null, 0),
        row("o", "gone", 2),
      ]),
    ).toEqual({ a: "1", c: "2", b: "3", o: "4" });
    expect(
      agendaChildGroups([row("a", "b", 0), row("b", "a", 1)])
        .get(null)
        ?.map((item) => item.id),
    ).toEqual(["a", "b"]);
  });
});

describe("unlistedAgendaItemIds", () => {
  const item = (
    id: string,
    parentId: string | null,
    generatedForDocumentId: string | null = null,
    extra: {
      hiddenWithDocumentId?: string | null;
      titleWithheld?: boolean;
    } = {},
  ) => ({
    id,
    parentId,
    generatedForDocumentId,
    hiddenWithDocumentId: extra.hiddenWithDocumentId ?? null,
    titleWithheld: extra.titleWithheld ?? false,
  });
  const unlisted = (
    items: ReturnType<typeof item>[],
    publicDocuments: { id: string; agendaItemId: string }[],
  ) => [...unlistedAgendaItemIds(items, publicDocuments)].sort();

  const items = [
    item("root", null),
    item("draft", "root", "d1"),
    item("published", "root", "d2"),
    item("plain", "root"),
  ];
  const d2 = { id: "d2", agendaItemId: "published" };

  it("marks the sub-item of a document that is not public", () => {
    expect(unlisted(items, [d2])).toEqual(["draft"]);
    expect(unlisted(items, [])).toEqual(["draft", "published"]);
  });

  it("marks nothing once every document is public", () => {
    expect(unlisted(items, [d2, { id: "d1", agendaItemId: "draft" }])).toEqual(
      [],
    );
  });

  it("is exactly what visibleAgendaItems leaves out for that viewer", () => {
    const kept = new Set(visibleAgendaItems(items, [d2]).map((row) => row.id));
    expect(unlisted(items, [d2])).toEqual(
      items.filter((row) => !kept.has(row.id)).map((row) => row.id),
    );
  });

  it("lists an item that stays for everyone without its title", () => {
    // The sub-item of a draft has a sub-item that stays, and a kept item
    // holds a public document: everyone gets both (titleHidden), numbered.
    const holding = [
      item("root", null),
      item("auto", "root", "d1"),
      item("child", "auto"),
      item("kept", "root", null, { hiddenWithDocumentId: "d9" }),
    ];
    expect(unlisted(holding, [{ id: "d5", agendaItemId: "kept" }])).toEqual([]);
  });

  it("marks the sub-items nobody else gets under an unlisted item", () => {
    const nested = [
      item("root", null),
      item("auto", "root", "d1"),
      item("inner", "auto", "d3"),
    ];
    expect(unlisted(nested, [])).toEqual(["auto", "inner"]);
    // The inner document is published: both stay for everyone.
    expect(unlisted(nested, [{ id: "d3", agendaItemId: "inner" }])).toEqual([]);
  });

  it("marks a withheld title that holds nothing, whoever manages", () => {
    const withheld = [
      item("root", null),
      item("gone", "root", null, { titleWithheld: true }),
    ];
    expect(unlisted(withheld, [])).toEqual(["gone"]);
  });

  it("gives the listed items the numbers an attendee reads", () => {
    const rows = [
      { ...item("root", null), order: 0 },
      { ...item("draft", "root", "d1"), order: 0 },
      { ...item("published", "root", "d2"), order: 1 },
      { ...item("plain", "root"), order: 2 },
    ];
    const marks = unlistedAgendaItemIds(rows, [d2]);
    const forManager = numberAgendaItems(
      rows.map((row) => ({ ...row, unlisted: marks.has(row.id) })),
    );
    const forAttendee = numberAgendaItems(visibleAgendaItems(rows, [d2]));
    expect(forManager.get("draft")).toBeNull();
    expect(forManager.get("published")).toBe("1.1");
    expect(forAttendee.size).toBe(3);
    for (const [id, number] of forAttendee) {
      expect(forManager.get(id)).toBe(number);
    }
  });
});

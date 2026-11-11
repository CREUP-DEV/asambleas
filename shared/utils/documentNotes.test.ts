import { describe, expect, it } from "vitest";
import { locateNote, placeNotes } from "./documentNotes";

const note = (
  id: string,
  anchor: { blockId: string; from: number; to: number; quote: string } | null,
  createdAt = "2026-11-01T10:00:00.000Z",
) => ({ id, anchor, createdAt });

describe("locateNote", () => {
  const text = "Las universidades podrán impartir enseñanzas propias.";

  it("stays where it was written while the text there is the quote", () => {
    expect(
      locateNote({ from: 4, to: 17, quote: "universidades" }, text),
    ).toEqual({ from: 4, to: 17 });
  });

  it("follows the quote when the text before it changed", () => {
    expect(
      locateNote({ from: 4, to: 17, quote: "universidades" }, `Todas ${text}`),
    ).toEqual({ from: 10, to: 23 });
  });

  it("is lost when the block no longer holds the quote", () => {
    expect(
      locateNote({ from: 4, to: 17, quote: "universidades" }, "Otro texto."),
    ).toBeNull();
    expect(locateNote({ from: 0, to: 0, quote: "" }, text)).toBeNull();
  });
});

describe("placeNotes", () => {
  const blocks = [
    { id: "b1", text: "Primer párrafo del texto." },
    { id: "b2", text: "Segundo párrafo del texto." },
  ];

  it("sorts the notes for a list", () => {
    const notes = [
      note("late", { blockId: "b2", from: 0, to: 7, quote: "Segundo" }),
      note("general-new", null, "2026-11-03T10:00:00.000Z"),
      note("gone-block", { blockId: "b9", from: 0, to: 3, quote: "Uno" }),
      note("second", { blockId: "b1", from: 7, to: 14, quote: "párrafo" }),
      note("general-old", null, "2026-11-02T10:00:00.000Z"),
      note("first", { blockId: "b1", from: 0, to: 6, quote: "Primer" }),
      note("gone-text", { blockId: "b1", from: 0, to: 5, quote: "Nunca" }),
    ];
    const placed = placeNotes(notes, blocks);
    expect(placed.general.map((n) => n.id)).toEqual([
      "general-old",
      "general-new",
    ]);
    expect(placed.placed.map((n) => n.id)).toEqual(["first", "second", "late"]);
    expect(placed.orphaned.map((n) => n.id).sort()).toEqual([
      "gone-block",
      "gone-text",
    ]);
  });
});

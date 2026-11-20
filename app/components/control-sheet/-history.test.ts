import { describe, expect, it } from "vitest";
import { historyMayChange } from "./-history";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const documents = [
  { id: "doc-1", agendaItemId: "item-1" },
  { id: "doc-2", agendaItemId: "item-2" },
];
const vote = (documentId?: string) => ({
  type: "vote_recorded",
  ...(documentId ? { documentId } : {}),
});

describe("historyMayChange", () => {
  it("fetches again for what the history lists, without filters", () => {
    expect(
      historyMayChange([vote("doc-1")], { groups: [] }, documents, NOW),
    ).toBe(true);
    expect(
      historyMayChange(
        [{ type: "control_sheet_observations_updated" }],
        { groups: [] },
        documents,
        NOW,
      ),
    ).toBe(true);
    expect(
      historyMayChange(
        [{ type: "poll" }],
        { groups: ["answers"] },
        documents,
        NOW,
      ),
    ).toBe(true);
  });

  it("never for what the history does not list", () => {
    for (const type of [
      "speaking_turn_added",
      "seating_person_updated",
      "live_changed",
      "headcount_recorded",
      "amendment_updated",
    ]) {
      expect(historyMayChange([{ type }], { groups: [] }, documents, NOW)).toBe(
        false,
      );
    }
  });

  it("only for the groups chosen", () => {
    expect(
      historyMayChange([vote("doc-1")], { groups: ["sheet"] }, documents, NOW),
    ).toBe(false);
    expect(
      historyMayChange([vote("doc-1")], { groups: ["votes"] }, documents, NOW),
    ).toBe(true);
    expect(
      historyMayChange(
        [{ type: "position_changed", documentId: "doc-1" }],
        { groups: ["sheet", "answers"] },
        documents,
        NOW,
      ),
    ).toBe(true);
  });

  it("never once the range of days ended, but while it reaches today", () => {
    expect(
      historyMayChange(
        [vote("doc-1")],
        { groups: [], to: "2026-11-18T23:00:00.000Z" },
        documents,
        NOW,
      ),
    ).toBe(false);
    expect(
      historyMayChange(
        [vote("doc-1")],
        { groups: [], to: "2026-11-20T23:00:00.000Z" },
        documents,
        NOW,
      ),
    ).toBe(true);
    // The stream down: fetched again whatever the range.
    expect(
      historyMayChange(
        [{ type: "poll" }],
        { groups: [], to: "2026-11-18T23:00:00.000Z" },
        documents,
        NOW,
      ),
    ).toBe(true);
  });

  it("for a document, never what is about another one", () => {
    const filters = { groups: [], subject: "document:doc-1" };
    expect(historyMayChange([vote("doc-2")], filters, documents, NOW)).toBe(
      false,
    );
    expect(historyMayChange([vote("doc-1")], filters, documents, NOW)).toBe(
      true,
    );
    // Without a document (the sheet's notes, a vote on an item) it may be.
    expect(historyMayChange([vote()], filters, documents, NOW)).toBe(true);
    expect(
      historyMayChange(
        [{ type: "control_sheet_treated_changed" }],
        filters,
        documents,
        NOW,
      ),
    ).toBe(true);
  });

  it("for an item, never what is about a document of another item", () => {
    const filters = { groups: [], subject: "item:item-1" };
    expect(historyMayChange([vote("doc-2")], filters, documents, NOW)).toBe(
      false,
    );
    expect(historyMayChange([vote("doc-1")], filters, documents, NOW)).toBe(
      true,
    );
    expect(historyMayChange([vote()], filters, documents, NOW)).toBe(true);
    // A document the page does not know (just created): it may be.
    expect(historyMayChange([vote("doc-9")], filters, documents, NOW)).toBe(
      true,
    );
  });

  it("counts one event that may match among others that do not", () => {
    expect(
      historyMayChange(
        [{ type: "speaking_turn_added" }, vote("doc-2"), vote("doc-1")],
        { groups: ["votes"], subject: "document:doc-1" },
        documents,
        NOW,
      ),
    ).toBe(true);
  });
});

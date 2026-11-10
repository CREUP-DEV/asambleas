import { describe, expect, it } from "vitest";
import type { DocumentStatus } from "~~/shared/constants/domain";
import {
  groupByAgendaItem,
  matchesTrackingFilter,
  summarizeTracking,
  trackingBucket,
  trackingState,
  type TrackedDocument,
} from "./-status";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const PAST = "2026-11-01T09:00:00.000Z";
const FUTURE = "2026-11-20T09:00:00.000Z";

function doc(
  status: DocumentStatus,
  overrides: Partial<TrackedDocument> = {},
): TrackedDocument {
  return {
    status,
    hasContent: false,
    correctionNote: null,
    correctionRequestedAt: null,
    dueAt: null,
    ...overrides,
  };
}

describe("trackingState", () => {
  it("reads an empty draft as expected and one with content as in preparation", () => {
    expect(trackingState(doc("draft"), NOW).state).toBe("expected");
    expect(trackingState(doc("draft", { hasContent: true }), NOW).state).toBe(
      "preparing",
    );
  });

  it("puts a correction request before the content", () => {
    expect(
      trackingState(
        doc("draft", {
          hasContent: true,
          correctionNote: "Falta el anexo",
          correctionRequestedAt: PAST,
        }),
        NOW,
      ).state,
    ).toBe("correction");
  });

  it("follows the status once the document was sent", () => {
    expect(trackingState(doc("submitted"), NOW).state).toBe("submitted");
    expect(trackingState(doc("published"), NOW).state).toBe("published");
    expect(trackingState(doc("withdrawn"), NOW).state).toBe("withdrawn");
    expect(trackingState(doc("postponed"), NOW).state).toBe("postponed");
  });

  it("marks drafts past their deadline as overdue, and nothing else", () => {
    expect(trackingState(doc("draft", { dueAt: PAST }), NOW).overdue).toBe(
      true,
    );
    expect(trackingState(doc("draft", { dueAt: FUTURE }), NOW).overdue).toBe(
      false,
    );
    expect(trackingState(doc("draft"), NOW).overdue).toBe(false);
    expect(trackingState(doc("submitted", { dueAt: PAST }), NOW).overdue).toBe(
      false,
    );
  });
});

describe("trackingBucket", () => {
  it("puts overdue drafts under overdue and the rest under their state", () => {
    expect(trackingBucket(doc("draft", { dueAt: PAST }), NOW)).toBe("overdue");
    expect(
      trackingBucket(doc("draft", { hasContent: true, dueAt: PAST }), NOW),
    ).toBe("overdue");
    expect(trackingBucket(doc("draft", { dueAt: FUTURE }), NOW)).toBe(
      "expected",
    );
    expect(trackingBucket(doc("submitted", { dueAt: PAST }), NOW)).toBe(
      "submitted",
    );
  });

  it("keeps a late correction under correction", () => {
    expect(
      trackingBucket(
        doc("draft", {
          hasContent: true,
          correctionNote: "Falta el anexo",
          correctionRequestedAt: PAST,
          dueAt: PAST,
        }),
        NOW,
      ),
    ).toBe("correction");
  });
});

describe("summarizeTracking", () => {
  it("counts each document once, so the tiles add up to the total", () => {
    const summary = summarizeTracking(
      [
        doc("draft", { dueAt: PAST }),
        doc("draft", { hasContent: true, dueAt: PAST }),
        doc("draft"),
        doc("draft", {
          correctionRequestedAt: PAST,
          hasContent: true,
          dueAt: PAST,
        }),
        doc("submitted", { dueAt: PAST }),
        doc("published"),
        doc("published"),
        doc("withdrawn"),
      ],
      NOW,
    );
    expect(summary).toEqual({
      total: 8,
      overdue: 2,
      expected: 1,
      preparing: 0,
      correction: 1,
      submitted: 1,
      published: 2,
      withdrawn: 1,
      postponed: 0,
    });
    const { total, ...tiles } = summary;
    expect(Object.values(tiles).reduce((sum, count) => sum + count, 0)).toBe(
      total,
    );
  });
});

describe("matchesTrackingFilter", () => {
  it("filters by the same tile the document counts under", () => {
    const late = doc("draft", { dueAt: PAST });
    expect(matchesTrackingFilter(late, "all", NOW)).toBe(true);
    expect(matchesTrackingFilter(late, "overdue", NOW)).toBe(true);
    expect(matchesTrackingFilter(late, "expected", NOW)).toBe(false);
    expect(matchesTrackingFilter(late, "published", NOW)).toBe(false);
    expect(matchesTrackingFilter(doc("draft"), "overdue", NOW)).toBe(false);
    expect(matchesTrackingFilter(doc("draft"), "expected", NOW)).toBe(true);
  });
});

describe("groupByAgendaItem", () => {
  const items = [
    { id: "i2", parentId: null, order: 2, title: "Informes" },
    { id: "i1", parentId: null, order: 1, title: "Apertura" },
    { id: "i21", parentId: "i2", order: 1, title: "Informe de la CEA" },
  ];

  it("follows the agenda order and numbering, skipping empty items", () => {
    const groups = groupByAgendaItem(items, [
      { id: "d1", agendaItemId: "i21" },
      { id: "d2", agendaItemId: "i2" },
      { id: "d3", agendaItemId: "i21" },
    ]);
    expect(
      groups.map((group) => [
        group.number,
        group.title,
        group.documents.map((value) => value.id),
      ]),
    ).toEqual([
      ["2", "Informes", ["d2"]],
      ["2.1", "Informe de la CEA", ["d1", "d3"]],
    ]);
  });

  it("puts documents of an unknown item last", () => {
    const groups = groupByAgendaItem(items, [
      { id: "d1", agendaItemId: "gone" },
      { id: "d2", agendaItemId: "i1" },
    ]);
    expect(groups.map((group) => group.itemId)).toEqual(["i1", "gone"]);
    expect(groups[1]!.number).toBeNull();
    expect(groups[1]!.unlisted).toBe(false);
  });

  it("gives no number to an item that is not in the agenda for everyone", () => {
    const groups = groupByAgendaItem(
      [
        { id: "r", parentId: null, order: 0, title: "Resoluciones" },
        { id: "a", parentId: "r", order: 0, title: "Borrador", unlisted: true },
        { id: "b", parentId: "r", order: 1, title: "Publicada" },
      ],
      [
        { id: "d1", agendaItemId: "a" },
        { id: "d2", agendaItemId: "b" },
      ],
    );
    expect(
      groups.map((group) => [group.number, group.unlisted, group.title]),
    ).toEqual([
      [null, true, "Borrador"],
      ["1.1", false, "Publicada"],
    ]);
  });
});

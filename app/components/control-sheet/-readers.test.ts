import { describe, expect, it } from "vitest";
import type { AmendmentDto, ControlSheetNotesDto } from "~~/shared/types/api";
import {
  amendmentOwnNotes,
  awaitsPresenterAnswer,
  generalOwnNotes,
  indexOwnNotes,
  latestNote,
} from "./-readers";
import type { AmendmentSheetRow, SheetRowDocument } from "./-model";

const note = (id: string, createdAt: string, updatedAt = createdAt) => ({
  id,
  body: `nota ${id}`,
  createdAt,
  updatedAt,
});

describe("latestNote", () => {
  it("picks the one written or edited last", () => {
    expect(latestNote([])).toBeNull();
    expect(
      latestNote([
        note("n1", "2026-11-20T10:00:00Z"),
        note("n2", "2026-11-20T11:00:00Z"),
      ])?.id,
    ).toBe("n2");
    // An older note edited later counts as the latest.
    expect(
      latestNote([
        note("n1", "2026-11-20T10:00:00Z", "2026-11-21T09:00:00Z"),
        note("n2", "2026-11-20T11:00:00Z"),
      ])?.id,
    ).toBe("n1");
    // A tie goes to the one later in the list (oldest first).
    expect(
      latestNote([
        note("n1", "2026-11-20T10:00:00Z"),
        note("n2", "2026-11-20T10:00:00Z"),
      ])?.id,
    ).toBe("n2");
  });
});

const dto: ControlSheetNotesDto = {
  documents: [
    {
      documentId: "d1",
      anchored: 0,
      notes: [
        { ...note("a", "2026-11-20T10:00:00Z"), anchor: null },
        { ...note("b", "2026-11-20T12:00:00Z"), anchor: null },
        { ...note("c", "2026-11-20T11:00:00Z"), anchor: null },
      ],
    },
    // Only anchored notes: nothing to show in the cell.
    { documentId: "d2", anchored: 2, notes: [] },
  ],
  amendments: [
    { amendmentId: "e1", notes: [note("x", "2026-11-20T10:00:00Z")] },
  ],
};
const notes = indexOwnNotes(dto);

const doc = (id: string, title: string) =>
  ({ id, title }) as unknown as SheetRowDocument;

describe("«Mis notas» in a row", () => {
  it("shows the latest note of the row's only document, unnamed", () => {
    expect(generalOwnNotes({ documents: [doc("d1", "Becas")] }, notes)).toEqual(
      [{ label: null, body: "nota b", more: 2 }],
    );
  });

  it("names each document on an item with several, skipping those without", () => {
    expect(
      generalOwnNotes(
        {
          documents: [doc("d2", "Plan"), doc("d1", "Becas"), doc("d3", "X")],
        },
        notes,
      ),
    ).toEqual([{ label: "Becas", body: "nota b", more: 2 }]);
  });

  it("shows an amendment's latest note, none when there is none", () => {
    expect(amendmentOwnNotes("e1", notes)).toEqual([
      { label: null, body: "nota x", more: 0 },
    ]);
    expect(amendmentOwnNotes("e2", notes)).toEqual([]);
    expect(amendmentOwnNotes("e1", indexOwnNotes(null))).toEqual([]);
  });
});

describe("awaitsPresenterAnswer", () => {
  const row = (
    dtoOver: Partial<AmendmentDto> = {},
    position: AmendmentSheetRow["position"] = null,
  ) => ({
    amendment: {
      status: "submitted",
      can: { position: true },
      ...dtoOver,
    } as AmendmentDto,
    position,
  });

  it("waits for a presenter while it can be answered and is unanswered", () => {
    expect(awaitsPresenterAnswer(row(), true)).toBe(true);
    expect(
      awaitsPresenterAnswer(
        row({}, {
          position: "pending",
          comment: null,
          recordedBy: "presenter",
        } as AmendmentSheetRow["position"]),
        true,
      ),
    ).toBe(true);
  });

  it("not for the Mesa, once answered, decided or held back", () => {
    expect(awaitsPresenterAnswer(row(), false)).toBe(false);
    expect(
      awaitsPresenterAnswer(
        row({}, {
          position: "accept",
          comment: null,
          recordedBy: "presenter",
        } as AmendmentSheetRow["position"]),
        true,
      ),
    ).toBe(false);
    expect(awaitsPresenterAnswer(row({ status: "approved" }), true)).toBe(
      false,
    );
    expect(
      awaitsPresenterAnswer(
        row({ can: { position: false } as AmendmentDto["can"] }),
        true,
      ),
    ).toBe(false);
  });
});

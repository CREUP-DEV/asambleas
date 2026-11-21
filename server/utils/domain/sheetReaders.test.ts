import { describe, expect, it, vi } from "vitest";
import type { AwaitingAnswerDocument, AwaitingAnswerRow } from "./sheetReaders";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { awaitingAnswerCounts, groupSheetNotes } =
  await import("./sheetReaders");

const DAY = new Date("2026-11-20T10:00:00Z");

function row(overrides: Partial<AwaitingAnswerRow> = {}): AwaitingAnswerRow {
  return {
    documentId: "doc",
    status: "submitted",
    admission: "admitted",
    validatedAt: DAY,
    publishedAt: DAY,
    approvalMethod: null,
    kind: "partial",
    outcomeVoteId: null,
    acceptances: [],
    position: { position: "pending" },
    ...overrides,
  };
}

const PRESENTED = new Map<string, AwaitingAnswerDocument>([
  [
    "doc",
    { acceptedAmendments: "vote", voted: false, presenterSeesValidated: false },
  ],
]);

describe("awaitingAnswerCounts", () => {
  it("counts the published, undecided amendments still without an answer", () => {
    const counts = awaitingAnswerCounts(
      [
        row(),
        row({ position: null }),
        row({ position: { position: "accept" } }),
        row({ position: { position: "transact" } }),
      ],
      PRESENTED,
    );
    expect(counts.get("doc")).toBe(2);
  });

  it("leaves out what is decided, not public yet or not the reader's", () => {
    const counts = awaitingAnswerCounts(
      [
        row({ status: "approved", approvalMethod: "vote" }),
        row({ status: "rejected" }),
        row({ publishedAt: null }),
        // Not validated yet (one the Mesa admitted is answered at once).
        row({ validatedAt: null, admission: "pending" }),
        row({ documentId: "other" }),
      ],
      PRESENTED,
    );
    expect(counts.size).toBe(0);
  });

  it("counts a validated one before publication when the presenter reads it", () => {
    const counts = awaitingAnswerCounts(
      [row({ publishedAt: null })],
      new Map([
        [
          "doc",
          {
            acceptedAmendments: "vote",
            voted: false,
            presenterSeesValidated: true,
          },
        ],
      ]),
    );
    expect(counts.get("doc")).toBe(1);
  });

  it("counts nothing once the document is voted", () => {
    const counts = awaitingAnswerCounts(
      [row()],
      new Map([
        [
          "doc",
          {
            acceptedAmendments: "vote",
            voted: true,
            presenterSeesValidated: false,
          },
        ],
      ]),
    );
    expect(counts.size).toBe(0);
  });

  it("waits for a transactional's main authors first", () => {
    const counts = awaitingAnswerCounts(
      [
        row({
          kind: "transactional",
          acceptances: [{ role: "author", decision: "pending" }],
        }),
        row({
          kind: "transactional",
          acceptances: [{ role: "author", decision: "accepted" }],
        }),
      ],
      PRESENTED,
    );
    expect(counts.get("doc")).toBe(1);
  });
});

function documentNote(
  id: string,
  documentId: string,
  blockId: string | null = null,
) {
  return {
    id,
    userId: "user",
    documentId,
    blockId,
    startOffset: blockId ? 0 : null,
    endOffset: blockId ? 4 : null,
    quote: blockId ? "text" : null,
    body: `note ${id}`,
    createdAt: DAY,
    updatedAt: DAY,
  };
}

function amendmentNote(id: string, amendmentId: string) {
  return {
    id,
    userId: "user",
    amendmentId,
    body: `note ${id}`,
    createdAt: DAY,
    updatedAt: DAY,
  };
}

describe("groupSheetNotes", () => {
  it("keeps the general notes of the documents shown, in order", () => {
    const dto = groupSheetNotes({
      documentRows: [
        documentNote("n1", "doc"),
        documentNote("n2", "doc", "block"),
        documentNote("n3", "doc"),
        documentNote("n4", "hidden"),
      ],
      anchoredCounts: [
        { documentId: "doc", total: 1 },
        { documentId: "hidden", total: 3 },
      ],
      amendmentRows: [],
      documentIds: new Set(["doc"]),
      amendmentIds: new Set(),
    });
    expect(dto.documents).toEqual([
      {
        documentId: "doc",
        anchored: 1,
        notes: [
          expect.objectContaining({ id: "n1", anchor: null }),
          expect.objectContaining({ id: "n3", anchor: null }),
        ],
      },
    ]);
  });

  it("lists a document with only anchored notes, by their count", () => {
    const dto = groupSheetNotes({
      documentRows: [],
      anchoredCounts: [{ documentId: "doc", total: 2 }],
      amendmentRows: [],
      documentIds: new Set(["doc"]),
      amendmentIds: new Set(),
    });
    expect(dto.documents).toEqual([
      { documentId: "doc", anchored: 2, notes: [] },
    ]);
  });

  it("keeps only the notes on amendments the reader sees", () => {
    const dto = groupSheetNotes({
      documentRows: [],
      anchoredCounts: [],
      amendmentRows: [
        amendmentNote("a1", "seen"),
        amendmentNote("a2", "unseen"),
        amendmentNote("a3", "seen"),
      ],
      documentIds: new Set(),
      amendmentIds: new Set(["seen"]),
    });
    expect(dto.amendments).toEqual([
      {
        amendmentId: "seen",
        notes: [
          expect.objectContaining({ id: "a1", body: "note a1" }),
          expect.objectContaining({ id: "a3" }),
        ],
      },
    ]);
  });
});

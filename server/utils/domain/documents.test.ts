import { describe, expect, it, vi } from "vitest";

vi.mock("h3", () => ({
  createError: (input: {
    statusCode: number;
    message: string;
    data?: unknown;
  }) => Object.assign(new Error(input.message), input),
  getRouterParam: vi.fn(),
}));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./actor", () => ({
  actsFor: vi.fn(),
  canManageAssemblies: vi.fn(),
  canManageDocuments: vi.fn(),
  canModerate: vi.fn(),
  canReviewAmendments: vi.fn(),
  requireActor: vi.fn(),
}));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("./resolvers", () => ({
  resolveAgendaItem: vi.fn(),
  resolveAssembly: vi.fn(),
  resolveDocument: vi.fn(),
}));

const {
  assemblySettings,
  assertStatusChange,
  isExpectedDocument,
  presentationClosed,
  toDocumentSummaryDto,
} = await import("./documents");

type DocumentRow = Parameters<typeof assertStatusChange>[0];
type NextStatus = Parameters<typeof assertStatusChange>[1];

const at = new Date("2026-11-01T10:00:00Z");

function doc(overrides: Partial<Record<keyof DocumentRow, unknown>>) {
  return {
    status: "draft",
    finalVoteId: null,
    publishedAt: null,
    baseVersionId: null,
    submittedAt: null,
    ...overrides,
  } as DocumentRow;
}

/** "ok" when the change is allowed, otherwise the HTTP status it answers. */
function outcome(document: DocumentRow, next: NextStatus): "ok" | number {
  try {
    assertStatusChange(document, next);
    return "ok";
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
}

describe("assertStatusChange", () => {
  it("withdraws only presented or public documents without a final vote", () => {
    expect(outcome(doc({ status: "draft" }), "withdrawn")).toBe(409);
    for (const status of ["submitted", "published", "postponed"]) {
      expect(outcome(doc({ status, submittedAt: at }), "withdrawn")).toBe("ok");
    }
    expect(outcome(doc({ status: "withdrawn" }), "withdrawn")).toBe("ok");
    expect(
      outcome(
        doc({ status: "published", publishedAt: at, finalVoteId: "v1" }),
        "withdrawn",
      ),
    ).toBe(409);
  });

  it("restores a withdrawn submission, never a draft or a published text", () => {
    expect(
      outcome(doc({ status: "withdrawn", submittedAt: at }), "submitted"),
    ).toBe("ok");
    expect(outcome(doc({ status: "withdrawn" }), "submitted")).toBe(409);
    expect(
      outcome(
        doc({ status: "withdrawn", submittedAt: at, publishedAt: at }),
        "submitted",
      ),
    ).toBe(409);
    expect(
      outcome(
        doc({ status: "withdrawn", submittedAt: at, baseVersionId: "b1" }),
        "submitted",
      ),
    ).toBe(409);
    expect(outcome(doc({ status: "draft" }), "submitted")).toBe(409);
    expect(
      outcome(doc({ status: "postponed", publishedAt: at }), "submitted"),
    ).toBe(409);
  });

  it("postpones only published documents", () => {
    expect(
      outcome(doc({ status: "published", publishedAt: at }), "postponed"),
    ).toBe("ok");
    expect(
      outcome(doc({ status: "submitted", submittedAt: at }), "postponed"),
    ).toBe(409);
  });

  it("refuses statuses that are not set through this endpoint", () => {
    expect(
      outcome(
        doc({ status: "submitted", submittedAt: at }),
        "published" as NextStatus,
      ),
    ).toBe(422);
  });
});

describe("presentationClosed", () => {
  const milestones = { documents_close: new Date("2026-11-02T10:00:00Z") };
  const after = new Date("2026-11-03T10:00:00Z");
  const open = { acceptsSubmissions: true };
  const reserved = { acceptsSubmissions: false };

  it("reopens presentation after a correction request, past the deadline", () => {
    expect(
      presentationClosed(
        { dueAt: null, correctionRequestedAt: at },
        open,
        milestones,
        after,
      ),
    ).toBe(false);
  });

  it("follows documents_close for documents members chose to present", () => {
    expect(
      presentationClosed(
        { dueAt: null, correctionRequestedAt: null },
        open,
        milestones,
        at,
      ),
    ).toBe(false);
    expect(
      presentationClosed(
        { dueAt: null, correctionRequestedAt: null },
        open,
        milestones,
        after,
      ),
    ).toBe(true);
  });

  it("lets an expected document be presented after documents_close", () => {
    expect(
      presentationClosed(
        { dueAt: at, correctionRequestedAt: null },
        open,
        milestones,
        after,
      ),
    ).toBe(false);
  });

  it("treats documents under items closed to members as expected", () => {
    // Only a manager could have created it, say a CEA report with no
    // internal deadline: its area must still be able to present it.
    expect(isExpectedDocument({ dueAt: null }, reserved)).toBe(true);
    expect(
      presentationClosed(
        { dueAt: null, correctionRequestedAt: null },
        reserved,
        milestones,
        after,
      ),
    ).toBe(false);
    expect(isExpectedDocument({ dueAt: null }, open)).toBe(false);
  });
});

describe("assemblySettings", () => {
  it("merges stored values over the defaults", () => {
    expect(
      assemblySettings({ settings: { tieRule: "repeat" } as never }),
    ).toMatchObject({ tieRule: "repeat", positionVisibility: "session" });
    expect(assemblySettings({ settings: null as never }).tieRule).toBe(
      "rejected",
    );
  });

  it("drops keys of removed policies", () => {
    const settings = assemblySettings({
      settings: {
        amendmentVisibility: "after_close",
        positionVisibility: "public",
      } as never,
    });
    expect(settings).not.toHaveProperty("amendmentVisibility");
    expect(settings.positionVisibility).toBe("public");
  });
});

describe("toDocumentSummaryDto", () => {
  const row = {
    id: "d1",
    slug: "informe",
    agendaItemId: "i1",
    kind: "executive_report",
    format: "structured",
    title: "Informe",
    reference: null,
    status: "draft",
    amendable: true,
    voted: true,
    majority: "two_thirds",
    publishedAt: null,
    submittedAt: null,
    dueAt: at,
    correctionNote: "Falta el resumen",
    correctionRequestedAt: at,
    consolidatedVersionId: null,
    updatedAt: at,
  } as unknown as Parameters<typeof toDocumentSummaryDto>[0];
  const extra = {
    proponent: null,
    amendmentCount: 0,
    window: { opensAt: null, closesAt: null, open: false },
    hasContent: false,
  };

  it("shows the correction only to presenters and managers", () => {
    expect(
      toDocumentSummaryDto(row, { ...extra, showCorrection: true }),
    ).toMatchObject({
      dueAt: at.toISOString(),
      hasContent: false,
      correctionNote: "Falta el resumen",
      correctionRequestedAt: at.toISOString(),
    });
    expect(
      toDocumentSummaryDto(row, { ...extra, showCorrection: false }),
    ).toMatchObject({ correctionNote: null, correctionRequestedAt: null });
  });
});

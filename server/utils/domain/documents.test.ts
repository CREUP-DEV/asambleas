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
  deleteBlocker,
  isExpectedDocument,
  presentationClosed,
  presentationItemAfterMove,
  requirePresentationChangeOpen,
  requireNotOthersAutoItem,
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

describe("deleteBlocker", () => {
  it("deletes a document never published, with or without amendments", () => {
    for (const status of ["draft", "submitted", "withdrawn"]) {
      expect(deleteBlocker(doc({ status }), false)).toBeNull();
    }
  });

  it("deletes a published text only while it has no amendments", () => {
    const published = [
      doc({ status: "published", publishedAt: at, baseVersionId: "b1" }),
      doc({ status: "withdrawn", publishedAt: at, baseVersionId: "b1" }),
      doc({ status: "postponed", publishedAt: at, baseVersionId: "b1" }),
      // A PDF document is published without a base version.
      doc({ status: "published", publishedAt: at }),
    ];
    for (const document of published) {
      expect(deleteBlocker(document, false)).toBeNull();
      expect(deleteBlocker(document, true)).toMatch(/retíralo/);
    }
  });

  it("never deletes a document with a final vote", () => {
    const voted = doc({
      status: "published",
      publishedAt: at,
      baseVersionId: "b1",
      finalVoteId: "v1",
    });
    expect(deleteBlocker(voted, false)).toMatch(/anula la votación final/);
  });
});

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

describe("requireNotOthersAutoItem", () => {
  it("refuses the automatic sub-item of another document, for anyone", () => {
    expect(() =>
      requireNotOthersAutoItem({ generatedForDocumentId: "d1" }, "d2"),
    ).toThrow(expect.objectContaining({ statusCode: 422 }));
    // Creating a document: no automatic sub-item is its own yet.
    expect(() =>
      requireNotOthersAutoItem({ generatedForDocumentId: "d1" }, null),
    ).toThrow(expect.objectContaining({ data: { reason: "auto_item" } }));
  });

  it("lets a document into an ordinary item or back into its own", () => {
    expect(() =>
      requireNotOthersAutoItem({ generatedForDocumentId: null }, "d1"),
    ).not.toThrow();
    expect(() =>
      requireNotOthersAutoItem({ generatedForDocumentId: "d1" }, "d1"),
    ).not.toThrow();
  });
});

describe("presentationClosed", () => {
  const milestones = { documents_close: new Date("2026-11-02T10:00:00Z") };
  const after = new Date("2026-11-03T10:00:00Z");
  const open = { acceptsSubmissions: true, generatedForDocumentId: null };
  const reserved = { acceptsSubmissions: false, generatedForDocumentId: null };
  // The automatic sub-item of a document presented under an item that
  // accepts submissions: it takes none itself.
  const automatic = { acceptsSubmissions: false, generatedForDocumentId: "d1" };

  it("reopens presentation after a correction request, past the deadline", () => {
    expect(
      presentationClosed(
        { kind: "resolution", dueAt: null, correctionRequestedAt: at },
        open,
        milestones,
        after,
      ),
    ).toBe(false);
  });

  it("follows documents_close for documents members chose to present", () => {
    expect(
      presentationClosed(
        { kind: "resolution", dueAt: null, correctionRequestedAt: null },
        open,
        milestones,
        at,
      ),
    ).toBe(false);
    expect(
      presentationClosed(
        { kind: "resolution", dueAt: null, correctionRequestedAt: null },
        open,
        milestones,
        after,
      ),
    ).toBe(true);
  });

  it("lets an expected document be presented after documents_close", () => {
    expect(
      presentationClosed(
        { kind: "resolution", dueAt: at, correctionRequestedAt: null },
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
        { kind: "resolution", dueAt: null, correctionRequestedAt: null },
        reserved,
        milestones,
        after,
      ),
    ).toBe(false);
    expect(isExpectedDocument({ dueAt: null }, open)).toBe(false);
  });

  it("never treats a document in an automatic sub-item as expected", () => {
    // A member presented it under a container: documents_close binds it,
    // although its own sub-item takes no submissions.
    expect(isExpectedDocument({ dueAt: null }, automatic)).toBe(false);
    expect(
      presentationClosed(
        { kind: "resolution", dueAt: null, correctionRequestedAt: null },
        automatic,
        milestones,
        at,
      ),
    ).toBe(false);
    expect(
      presentationClosed(
        { kind: "resolution", dueAt: null, correctionRequestedAt: null },
        automatic,
        milestones,
        after,
      ),
    ).toBe(true);
  });

  it("keeps the internal deadline of a document in an automatic sub-item", () => {
    // The Secretaría added it there with a deadline of its own.
    expect(isExpectedDocument({ dueAt: at }, automatic)).toBe(true);
    expect(
      presentationClosed(
        { kind: "resolution", dueAt: at, correctionRequestedAt: null },
        automatic,
        milestones,
        after,
      ),
    ).toBe(false);
  });

  it("follows each kind's own deadline (presentationDeadlinePassed)", () => {
    const calendar = {
      documents_close: new Date("2026-11-02T10:00:00Z"),
      reports_close: new Date("2026-11-04T10:00:00Z"),
      candidacies_close: new Date("2026-11-05T10:00:00Z"),
    };
    // Past documents_close, before candidacies_close: a candidacy still goes.
    expect(
      presentationClosed(
        { kind: "candidacy", dueAt: null, correctionRequestedAt: null },
        open,
        calendar,
        after,
      ),
    ).toBe(false);
    // A report past reports_close no longer goes.
    expect(
      presentationClosed(
        { kind: "report", dueAt: null, correctionRequestedAt: null },
        open,
        calendar,
        new Date("2026-11-04T10:01:00Z"),
      ),
    ).toBe(true);
  });
});

describe("requirePresentationChangeOpen", () => {
  const calendar = {
    documents_close: new Date("2026-11-02T10:00:00Z"),
    candidacies_close: new Date("2026-11-05T10:00:00Z"),
  };
  // Past documents_close, before candidacies_close.
  const between = new Date("2026-11-03T10:00:00Z");
  const open = { acceptsSubmissions: true, generatedForDocumentId: null };
  const reserved = { acceptsSubmissions: false, generatedForDocumentId: null };
  const automatic = { acceptsSubmissions: false, generatedForDocumentId: "d1" };
  // What insertAutoItem returns: bindAutoItem sets generatedForDocumentId
  // only after the checks, so the row alone reads as `reserved`.
  const inserted = { acceptsSubmissions: false, generatedForDocumentId: null };
  const candidacy = {
    kind: "candidacy" as const,
    dueAt: null,
    correctionRequestedAt: null,
  };
  const resolution = { ...candidacy, kind: "resolution" as const };
  const refused = {
    statusCode: 409,
    message: "El plazo de presentación de documentos ha terminado",
    data: { reason: "documents_deadline_passed" },
  };
  type Change = Parameters<typeof requirePresentationChangeOpen>[1];
  const check =
    (document: typeof candidacy | typeof resolution, change: Change) => () =>
      requirePresentationChangeOpen(document, change, calendar, between);

  it("refuses a kind whose deadline has passed, as creating it", () => {
    for (const item of [open, automatic]) {
      expect(
        check(candidacy, { kind: "resolution", before: item, after: item }),
      ).toThrow(expect.objectContaining(refused));
    }
  });

  it("refuses a kind change made with a move into a new automatic sub-item", () => {
    // The move binds the new sub-item to the document: never read as
    // reserved, so the deadline still applies.
    const after = presentationItemAfterMove("d1", open, inserted);
    expect(after).toEqual(automatic);
    expect(
      check(candidacy, { kind: "resolution", before: automatic, after }),
    ).toThrow(expect.objectContaining(refused));
  });

  it("refuses a move out of a reserved item past the kind's deadline", () => {
    // The Secretaría expected it there; a move to an item that takes
    // submissions would leave a draft the member cannot send.
    expect(
      check(resolution, {
        kind: "resolution",
        before: reserved,
        after: presentationItemAfterMove("d1", open, inserted),
      }),
    ).toThrow(expect.objectContaining(refused));
  });

  it("moves a draft already closed, or still open after the move", () => {
    const after = presentationItemAfterMove("d1", open, inserted);
    // A resolution past documents_close in an automatic sub-item: it could
    // not be sent before either.
    expect(
      check(resolution, { kind: "resolution", before: automatic, after }),
    ).not.toThrow();
    // A candidacy before candidacies_close, out of a reserved item too.
    for (const before of [automatic, reserved]) {
      expect(
        check(candidacy, { kind: "candidacy", before, after }),
      ).not.toThrow();
    }
    // Into an item reserved to the Secretaría (managers move it there).
    expect(
      check(resolution, {
        kind: "resolution",
        before: automatic,
        after: presentationItemAfterMove("d1", reserved, null),
      }),
    ).not.toThrow();
  });

  it("takes a kind still in its deadline, and always keeps the current one", () => {
    expect(
      check(resolution, { kind: "venue", before: open, after: open }),
    ).not.toThrow();
    // A resolution past documents_close stays a resolution (title, summary).
    expect(
      check(resolution, { kind: "resolution", before: open, after: open }),
    ).not.toThrow();
  });

  it("leaves expected documents and corrections free, as presentationClosed", () => {
    const moved = presentationItemAfterMove("d1", open, inserted);
    const exempt = [
      { document: { ...candidacy, dueAt: at }, before: open, after: moved },
      { document: candidacy, before: reserved, after: reserved },
      {
        document: { ...candidacy, correctionRequestedAt: at },
        before: open,
        after: moved,
      },
    ];
    for (const { document, before, after } of exempt) {
      expect(() =>
        requirePresentationChangeOpen(
          document,
          { kind: "resolution", before, after },
          calendar,
          between,
        ),
      ).not.toThrow();
    }
  });
});

describe("assemblySettings", () => {
  it("merges stored values over the defaults", () => {
    expect(
      assemblySettings({ settings: { tieRule: "repeat" } as never }),
    ).toMatchObject({ tieRule: "repeat", denominator: "present" });
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
    // Who sees the answers is decided per document now.
    expect(settings).not.toHaveProperty("positionVisibility");
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
    coProponents: [],
    amendmentCount: 0,
    hasAmendments: null,
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

  it("carries the co-presenters and the rule for accepted amendments", () => {
    const co = {
      id: "m2",
      acronym: "CEUM",
      name: "CEUM",
      kind: "asociado" as const,
    };
    expect(
      toDocumentSummaryDto(
        { ...row, acceptedAmendments: "incorporate" },
        { ...extra, coProponents: [co], showCorrection: false },
      ),
    ).toMatchObject({ coProponents: [co], acceptedAmendments: "incorporate" });
  });
});

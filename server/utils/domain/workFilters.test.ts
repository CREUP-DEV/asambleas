import { describe, expect, it, vi } from "vitest";

// Only the pure filters are tested: stub what touches the database.
vi.mock("h3", () => ({
  createError: (input: {
    statusCode: number;
    message: string;
    data?: unknown;
  }) => Object.assign(new Error(input.message), input),
  getRouterParam: vi.fn(),
  readBody: vi.fn(),
}));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./actor", () => ({
  actsFor: vi.fn(),
  canManageAssemblies: vi.fn(),
  canManageDocuments: vi.fn(),
  canModerate: vi.fn(),
  canRecordResults: vi.fn(),
  canReviewAmendments: vi.fn(),
  requireActor: vi.fn(),
  UNLINKED_ACCOUNT_MESSAGE: "Tu cuenta no está vinculada a ningún miembro",
}));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("./resolvers", () => ({
  resolveAgendaItem: vi.fn(),
  resolveAmendment: vi.fn(),
  resolveAssembly: vi.fn(),
  resolveDocument: vi.fn(),
}));
vi.mock("../errors", () => ({ isUniqueConstraintViolation: vi.fn() }));

const {
  acceptsAmendmentDrafts,
  isShelvedDocument,
  isWorkDocumentOpen,
  SHELVED_DOCUMENT_STATUSES,
} = await import("./workFilters");

const close = new Date("2026-11-10T22:59:00Z");
const before = new Date("2026-11-10T12:00:00Z");
const after = new Date("2026-11-11T09:00:00Z");
const milestones = { documents_close: close };

const draft = {
  status: "draft" as const,
  dueAt: null,
  correctionRequestedAt: null,
};
const openItem = { acceptsSubmissions: true, generatedForDocumentId: null };

describe("isWorkDocumentOpen", () => {
  it("keeps a member's draft until documents_close", () => {
    expect(isWorkDocumentOpen(draft, openItem, milestones, false, before)).toBe(
      true,
    );
  });

  it("drops a member's draft once documents_close has passed", () => {
    expect(isWorkDocumentOpen(draft, openItem, milestones, false, after)).toBe(
      false,
    );
  });

  it("keeps it for a manager, who is not bound by the deadline", () => {
    expect(isWorkDocumentOpen(draft, openItem, milestones, true, after)).toBe(
      true,
    );
  });

  it("keeps an expected document and a correction past the deadline", () => {
    const expected = { ...draft, dueAt: new Date("2026-11-09T00:00:00Z") };
    expect(
      isWorkDocumentOpen(expected, openItem, milestones, false, after),
    ).toBe(true);
    const corrected = { ...draft, correctionRequestedAt: before };
    expect(
      isWorkDocumentOpen(corrected, openItem, milestones, false, after),
    ).toBe(true);
    const closedItem = {
      acceptsSubmissions: false,
      generatedForDocumentId: null,
    };
    expect(
      isWorkDocumentOpen(draft, closedItem, milestones, false, after),
    ).toBe(true);
  });

  it("drops a draft under an automatic sub-item, bound by the deadline", () => {
    const auto = { acceptsSubmissions: false, generatedForDocumentId: "doc" };
    expect(isWorkDocumentOpen(draft, auto, milestones, false, after)).toBe(
      false,
    );
  });

  it("keeps every other status and a draft whose item is gone", () => {
    for (const status of ["submitted", "published"] as const) {
      expect(
        isWorkDocumentOpen(
          { ...draft, status },
          openItem,
          milestones,
          false,
          after,
        ),
      ).toBe(true);
    }
    expect(isWorkDocumentOpen(draft, undefined, milestones, false, after)).toBe(
      true,
    );
  });

  it("keeps a draft when the assembly has no documents_close", () => {
    expect(isWorkDocumentOpen(draft, openItem, {}, false, after)).toBe(true);
  });
});

describe("acceptsAmendmentDrafts", () => {
  const document = {
    status: "published" as const,
    format: "structured",
    amendable: true,
    baseVersionId: "v1",
    finalVoteId: null,
    consolidatedVersionId: null,
  };

  it("accepts a published, amendable, structured text not voted", () => {
    expect(acceptsAmendmentDrafts(document)).toBe(true);
  });

  it("refuses a voted or consolidated document", () => {
    expect(acceptsAmendmentDrafts({ ...document, finalVoteId: "vote" })).toBe(
      false,
    );
    expect(
      acceptsAmendmentDrafts({ ...document, consolidatedVersionId: "v2" }),
    ).toBe(false);
  });

  it("refuses a withdrawn or postponed document", () => {
    for (const status of SHELVED_DOCUMENT_STATUSES) {
      expect(acceptsAmendmentDrafts({ ...document, status })).toBe(false);
    }
  });

  it("refuses a document that no longer takes amendments", () => {
    expect(acceptsAmendmentDrafts({ ...document, amendable: false })).toBe(
      false,
    );
    expect(acceptsAmendmentDrafts({ ...document, format: "file" })).toBe(false);
    expect(acceptsAmendmentDrafts({ ...document, baseVersionId: null })).toBe(
      false,
    );
  });
});

describe("isShelvedDocument", () => {
  it("is withdrawn or postponed only", () => {
    expect(isShelvedDocument({ status: "withdrawn" })).toBe(true);
    expect(isShelvedDocument({ status: "postponed" })).toBe(true);
    expect(isShelvedDocument({ status: "published" })).toBe(false);
    expect(isShelvedDocument({ status: "draft" })).toBe(false);
  });
});

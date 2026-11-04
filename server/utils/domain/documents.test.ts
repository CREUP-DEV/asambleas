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

const { assertStatusChange } = await import("./documents");

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

import { describe, expect, it, vi } from "vitest";

// The pure rules loadDocumentDto uses for the working version and
// `hasContent` (the loaders need the database).
vi.mock("h3", () => ({
  createError: (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), input),
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

const { documentHasContent, isTextFrozen, needsWorkingBlocks } =
  await import("./documents");

type Row = Parameters<typeof documentHasContent>[0];

const at = new Date("2026-11-01T10:00:00Z");
const blocks = [{ type: "paragraph" }];

function row(overrides: Partial<Row> = {}): Row {
  return {
    status: "draft",
    format: "structured",
    fileUrl: null,
    workingVersionId: "w1",
    baseVersionId: null,
    publishedAt: null,
    ...overrides,
  };
}

const published = row({
  status: "published",
  baseVersionId: "b1",
  publishedAt: at,
});

describe("needsWorkingBlocks", () => {
  it("reads the working text while it can change", () => {
    expect(needsWorkingBlocks(row())).toBe(true);
    expect(needsWorkingBlocks(row({ status: "submitted" }))).toBe(true);
  });

  it("skips it once the text is frozen as a base", () => {
    expect(isTextFrozen(published)).toBe(true);
    expect(needsWorkingBlocks(published)).toBe(false);
    // Withdrawn or postponed after publication: still frozen.
    expect(needsWorkingBlocks({ ...published, status: "withdrawn" })).toBe(
      false,
    );
  });

  it("still reads it for a structured text frozen without a base", () => {
    expect(
      needsWorkingBlocks(row({ status: "published", publishedAt: at })),
    ).toBe(true);
  });

  it("skips it for a published PDF", () => {
    expect(
      needsWorkingBlocks(
        row({ format: "file", status: "published", publishedAt: at }),
      ),
    ).toBe(false);
  });
});

describe("documentHasContent", () => {
  it("a PDF has content when it was uploaded", () => {
    const pdf = row({ format: "file", workingVersionId: null });
    expect(documentHasContent(pdf, { working: null, base: null })).toBe(false);
    expect(
      documentHasContent(
        { ...pdf, fileUrl: "/api/uploads/documents/a.pdf" },
        { working: null, base: null },
      ),
    ).toBe(true);
  });

  it("an editable text counts its working blocks", () => {
    expect(documentHasContent(row(), { working: { blocks }, base: null })).toBe(
      true,
    );
    expect(
      documentHasContent(row(), { working: { blocks: [] }, base: null }),
    ).toBe(false);
    // A placeholder without a working version.
    expect(
      documentHasContent(row({ workingVersionId: null }), {
        working: null,
        base: null,
      }),
    ).toBe(false);
  });

  it("a frozen text answers with its base, whose copy the working version is", () => {
    expect(
      documentHasContent(published, { working: null, base: { blocks } }),
    ).toBe(true);
    expect(
      documentHasContent(published, { working: null, base: { blocks: [] } }),
    ).toBe(false);
    // Without a working version, as loadContentFlags: no content.
    expect(
      documentHasContent(
        { ...published, workingVersionId: null },
        { working: null, base: { blocks } },
      ),
    ).toBe(false);
  });

  it("a structured text frozen without a base reads the working version", () => {
    const noBase = row({ status: "published", publishedAt: at });
    expect(
      documentHasContent(noBase, { working: { blocks }, base: null }),
    ).toBe(true);
    expect(documentHasContent(noBase, { working: null, base: null })).toBe(
      false,
    );
  });
});

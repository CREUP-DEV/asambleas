import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("h3", () => ({
  createError: (input: {
    statusCode: number;
    message: string;
    data?: unknown;
  }) => Object.assign(new Error(input.message), input),
}));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./actor", () => ({
  canManageDocuments: vi.fn(() => false),
  UNLINKED_ACCOUNT_MESSAGE: "unlinked",
}));
vi.mock("./agendaWrites", () => ({
  bindAutoItem: vi.fn(),
  insertAutoItem: vi.fn(),
  lockAssembly: vi.fn(),
}));
vi.mock("./documents", () => ({
  documentsDeadlinePassed: vi.fn(() => false),
  FILE_FORMAT_REFUSED_MESSAGE: "format",
  hashBlocks: vi.fn(),
  loadMilestones: vi.fn(async () => ({})),
  requireMember: vi.fn(),
  requireMembers: vi.fn(),
  requireNotOthersAutoItem: vi.fn(),
  requirePresentersMayPresent: vi.fn(),
  requireSubmissionTarget: vi.fn(),
  uniqueDocumentSlug: vi.fn(),
}));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("./executiveMembers", () => ({ resolveBodyMembers: vi.fn() }));
vi.mock("./presenters", () => ({
  planPresenters: vi.fn(),
  PRESENTERS_MESSAGES: {},
  saveCoProponents: vi.fn(),
}));

const documentHelpers = await import("./documents");
const { createDocuments } = await import("./documentCreate");
const { ASSEMBLY_CLOSED_REASON, DOCUMENTS_DEADLINE_PASSED_REASON } =
  await import("./documentRefusals");

type Ctx = Parameters<typeof createDocuments>[0];

/** A member that may present documents, linked to its member. */
const member = {
  memberId: "member-1",
  can: () => true,
} as unknown as Ctx["actor"];

function create(status: string) {
  return createDocuments(
    { actor: member, assembly: { id: "a1", status }, agendaItemId: "i1" },
    [{ title: "Resolución" } as Parameters<typeof createDocuments>[1][0]],
  );
}

describe("createDocuments by a member", () => {
  beforeEach(() => {
    vi.mocked(documentHelpers.documentsDeadlinePassed).mockReturnValue(false);
  });

  it("names a closed assembly, not a stale read", async () => {
    await expect(create("closed")).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: ASSEMBLY_CLOSED_REASON },
    });
  });

  it("names a past documents_close, not a stale read", async () => {
    vi.mocked(documentHelpers.documentsDeadlinePassed).mockReturnValue(true);
    await expect(create("published")).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: DOCUMENTS_DEADLINE_PASSED_REASON },
    });
  });
});

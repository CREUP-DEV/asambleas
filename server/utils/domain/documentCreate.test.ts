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
const { resolveBodyMembers } = await import("./executiveMembers");
const { createDocuments } = await import("./documentCreate");
const { ASSEMBLY_CLOSED_REASON, DOCUMENTS_DEADLINE_PASSED_REASON } =
  await import("./documentRefusals");

type Ctx = Parameters<typeof createDocuments>[0];

/** A member that may present documents, linked to its member. */
const member = {
  memberId: "member-1",
  can: () => true,
} as unknown as Ctx["actor"];

type Input = Parameters<typeof createDocuments>[1][number];

function create(status: string, kinds: Input["kind"][] = ["resolution"]) {
  return createDocuments(
    { actor: member, assembly: { id: "a1", status }, agendaItemId: "i1" },
    kinds.map((kind) => ({ title: "Documento", kind }) as Input),
  );
}

/**
 * documents_close passed two days ago; reports_close (in a day) and
 * candidacies_close (in two) still ahead.
 */
function betweenDeadlines() {
  const now = Date.now();
  vi.mocked(documentHelpers.loadMilestones).mockResolvedValue({
    documents_close: new Date(now - 2 * 86_400_000),
    reports_close: new Date(now + 86_400_000),
    candidacies_close: new Date(now + 2 * 86_400_000),
  });
}

/** Stops right after the deadline checks: nothing is planned or written. */
const PLANNED = new Error("planned");

describe("createDocuments by a member", () => {
  beforeEach(() => {
    vi.mocked(documentHelpers.loadMilestones).mockResolvedValue({});
    vi.mocked(resolveBodyMembers).mockRejectedValue(PLANNED);
  });

  it("names a closed assembly, not a stale read", async () => {
    await expect(create("closed")).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: ASSEMBLY_CLOSED_REASON },
    });
  });

  it("names a past documents_close, not a stale read", async () => {
    betweenDeadlines();
    await expect(create("published")).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: DOCUMENTS_DEADLINE_PASSED_REASON },
    });
  });

  it("takes a candidacy or a venue until candidacies_close", async () => {
    betweenDeadlines();
    await expect(create("published", ["candidacy"])).rejects.toBe(PLANNED);
    await expect(create("published", ["venue"])).rejects.toBe(PLANNED);
  });

  it("takes a report past documents_close until its own deadline", async () => {
    betweenDeadlines();
    await expect(create("published", ["report"])).rejects.toBe(PLANNED);
  });

  it("refuses a report past reports_close", async () => {
    vi.mocked(documentHelpers.loadMilestones).mockResolvedValue({
      reports_close: new Date(Date.now() - 86_400_000),
    });
    await expect(create("published", ["report"])).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: DOCUMENTS_DEADLINE_PASSED_REASON },
    });
  });

  it("refuses a candidacy past candidacies_close", async () => {
    vi.mocked(documentHelpers.loadMilestones).mockResolvedValue({
      candidacies_close: new Date(Date.now() - 86_400_000),
    });
    await expect(create("published", ["candidacy"])).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: DOCUMENTS_DEADLINE_PASSED_REASON },
    });
  });

  it("names the row of several that is past its deadline", async () => {
    betweenDeadlines();
    await expect(
      create("published", ["candidacy", "resolution"]),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { reason: DOCUMENTS_DEADLINE_PASSED_REASON, index: 1 },
    });
  });
});

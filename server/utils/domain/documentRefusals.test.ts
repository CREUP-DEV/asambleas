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
  canManageDocuments: vi.fn(() => true),
  canModerate: vi.fn(),
  canRecordResults: vi.fn(() => true),
  canReviewAmendments: vi.fn(),
  requireActor: vi.fn(),
}));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("./resolvers", () => ({
  resolveAgendaItem: vi.fn(),
  resolveAssembly: vi.fn(),
  resolveDocument: vi.fn(),
}));

const { annulFinalVote, submitDocument } = await import("./documents");
const { ASSEMBLY_CLOSED_REASON } = await import("./documentRefusals");

type Ctx = Parameters<typeof submitDocument>[0];

/** A closed assembly: both refusals come before any read. */
const ctx = {
  actor: {},
  assembly: { id: "a1", status: "closed" },
  document: { id: "d1" },
} as unknown as Ctx;

const closed = {
  statusCode: 409,
  data: { reason: ASSEMBLY_CLOSED_REASON },
};

describe("a closed assembly", () => {
  it("names itself when a document is sent", async () => {
    await expect(submitDocument(ctx, {})).rejects.toMatchObject(closed);
  });

  it("answers an annulled final vote as an item vote is answered", async () => {
    await expect(
      annulFinalVote(
        ctx,
        {} as unknown as Parameters<typeof annulFinalVote>[1],
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { messageKey: "common.errors.voteAssemblyClosed" },
    });
  });
});

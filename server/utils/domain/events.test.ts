import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));

const { eventImpersonationId, recordEvent } = await import("./events");

/** An executor that records the insert and the notification. */
function fakeExecutor() {
  const inserted: Record<string, unknown>[] = [];
  const executor = {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push(values);
      },
    }),
    execute: async () => undefined,
  };
  return { executor: executor as never, inserted };
}

const target = {
  user: { id: "target" },
  memberId: "member-1",
  impersonation: { id: "imp1" },
};

describe("eventImpersonationId", () => {
  it("takes the actor's impersonation unless one is given", () => {
    expect(eventImpersonationId({ actor: target as never })).toBe("imp1");
    expect(
      eventImpersonationId({ actor: target as never, impersonationId: "imp2" }),
    ).toBe("imp2");
    expect(eventImpersonationId({ actor: null, impersonationId: "imp3" })).toBe(
      "imp3",
    );
    expect(eventImpersonationId({ actor: { impersonation: null } })).toBeNull();
    expect(eventImpersonationId({})).toBeNull();
  });
});

describe("recordEvent", () => {
  it("records the account acted as and the impersonation behind it", async () => {
    const { executor, inserted } = fakeExecutor();
    await recordEvent(executor, {
      assemblyId: "asm1",
      entityType: "amendment",
      entityId: "am1",
      type: "position_changed",
      actor: target as never,
    });
    expect(inserted[0]).toMatchObject({
      actorUserId: "target",
      actorMemberId: "member-1",
      impersonationId: "imp1",
      payload: {},
    });
  });

  it("keeps the impersonation of an actor-less side effect", async () => {
    const { executor, inserted } = fakeExecutor();
    await recordEvent(executor, {
      assemblyId: "asm1",
      entityType: "amendment",
      entityId: "tr1",
      type: "amendment_withdrawn",
      actor: null,
      impersonationId: "imp1",
    });
    expect(inserted[0]).toMatchObject({
      actorUserId: null,
      actorMemberId: null,
      impersonationId: "imp1",
    });
  });

  it("records no impersonation for a plain actor", async () => {
    const { executor, inserted } = fakeExecutor();
    await recordEvent(executor, {
      assemblyId: "asm1",
      entityType: "document",
      entityId: "d1",
      type: "document_created",
      actor: { user: { id: "u1" }, memberId: null } as never,
    });
    expect(inserted[0]).toMatchObject({
      actorUserId: "u1",
      impersonationId: null,
    });
  });
});

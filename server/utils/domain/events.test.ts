import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));

const {
  eventImpersonationId,
  holdLiveNotices,
  notifyLive,
  recordEvent,
  sendLiveNotices,
} = await import("./events");

/** An executor that records the insert and the notification. */
function fakeExecutor() {
  const inserted: Record<string, unknown>[] = [];
  const executed: unknown[] = [];
  const executor = {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push(values);
      },
    }),
    execute: async (query: unknown) => {
      executed.push(query);
    },
  };
  return { executor: executor as never, inserted, executed };
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

describe("holdLiveNotices", () => {
  const message = {
    assemblyId: "asm1",
    entityType: "amendment" as const,
    entityId: "am1",
    type: "amendment_approved",
    documentId: "d1",
  };

  it("notifies at once outside a hold", async () => {
    const { executor, executed } = fakeExecutor();
    await notifyLive(executor, message);
    expect(executed).toHaveLength(1);
  });

  it("holds the notices of what it records, history and all", async () => {
    const { executor, executed, inserted } = fakeExecutor();
    const held: unknown[] = [];
    const result = await holdLiveNotices(held as never, async () => {
      await recordEvent(executor, { ...message, actor: null });
      await notifyLive(executor, { ...message, entityId: "am2" });
      return "done";
    });
    expect(result).toBe("done");
    // The history row is written; the notification waits.
    expect(inserted[0]).toMatchObject({ type: "amendment_approved" });
    expect(executed).toHaveLength(0);
    expect(held).toEqual([message, { ...message, entityId: "am2" }]);
    // Outside the hold, notifying works as before.
    await notifyLive(executor, message);
    expect(executed).toHaveLength(1);
  });

  it("keeps each request's hold apart", async () => {
    const { executor, executed } = fakeExecutor();
    const first: unknown[] = [];
    const second: unknown[] = [];
    await Promise.all([
      holdLiveNotices(first as never, async () => {
        await Promise.resolve();
        await notifyLive(executor, { ...message, entityId: "a" });
      }),
      holdLiveNotices(second as never, async () => {
        await notifyLive(executor, { ...message, entityId: "b" });
      }),
      notifyLive(executor, { ...message, entityId: "c" }),
    ]);
    expect(first).toEqual([{ ...message, entityId: "a" }]);
    expect(second).toEqual([{ ...message, entityId: "b" }]);
    expect(executed).toHaveLength(1);
  });

  it("sends the held notices in one statement, each once", async () => {
    const { executor, executed } = fakeExecutor();
    await sendLiveNotices(executor, [
      message,
      message,
      { ...message, entityId: "am2" },
    ]);
    expect(executed).toHaveLength(1);
    // The statement carries the notices as one JSON array, the repeated one
    // once.
    const chunks = (executed[0] as { queryChunks: unknown[] }).queryChunks;
    const list = chunks.find(
      (chunk): chunk is string =>
        typeof chunk === "string" && chunk.startsWith("["),
    );
    expect(
      (JSON.parse(list ?? "[]") as string[]).map((payload) =>
        JSON.parse(payload),
      ),
    ).toEqual([message, { ...message, entityId: "am2" }]);
    await sendLiveNotices(executor, []);
    expect(executed).toHaveLength(1);
  });

  it("sends them one by one if the batch fails", async () => {
    const executed: unknown[] = [];
    let calls = 0;
    const executor = {
      execute: async (query: unknown) => {
        calls += 1;
        if (calls === 1) throw new Error("batch failed");
        executed.push(query);
      },
    } as never;
    await sendLiveNotices(executor, [
      message,
      message,
      { ...message, entityId: "am2" },
    ]);
    // One by one, the repeated one still once.
    expect(executed).toHaveLength(2);
  });
});

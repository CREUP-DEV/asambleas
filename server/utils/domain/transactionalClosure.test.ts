import { describe, expect, it, vi } from "vitest";
import type { Actor } from "./actor";
import type { RestoreRow } from "./transactionalClosure";

// The planners are pure; the restore runs on a stubbed transaction.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));

const { recordEvent } = await import("./events");
const {
  buildSourceMap,
  competingTransactionalIds,
  inadmissibleSourcePlan,
  latestByEntity,
  proposedAcceptanceLockIds,
  reopenTransactionalsClosedBy,
  restoreLockIds,
  rowsAfterReopen,
  transactionalsOverIds,
  transactionalsToClose,
  transactionalsToRestore,
} = await import("./transactionalClosure");

describe("inadmissibleSourcePlan", () => {
  // T1 groups A (on time) and L (late), T2 groups L alone, T3 groups L and
  // M (both late), T4 groups A only.
  const sourceMap = buildSourceMap([
    { transactionalId: "T1", sourceId: "A" },
    { transactionalId: "T1", sourceId: "L" },
    { transactionalId: "T2", sourceId: "L" },
    { transactionalId: "T3", sourceId: "L" },
    { transactionalId: "T3", sourceId: "M" },
    { transactionalId: "T4", sourceId: "A" },
  ]);
  const open = (id: string) => ({ id, status: "submitted" as const });

  it("drops the parent where another is left and lapses where none is", () => {
    expect(
      inadmissibleSourcePlan(
        sourceMap,
        ["L"],
        [open("T1"), open("T2"), open("T3"), open("T4")],
      ),
    ).toEqual({
      drop: [
        { id: "T1", sourceIds: ["L"], remainingIds: ["A"] },
        { id: "T3", sourceIds: ["L"], remainingIds: ["M"] },
      ],
      lapse: [{ id: "T2", sourceIds: ["L"] }],
    });
  });

  it("lapses one whose parents are all declared inadmissible together", () => {
    expect(inadmissibleSourcePlan(sourceMap, ["L", "M"], [open("T3")])).toEqual(
      { drop: [], lapse: [{ id: "T3", sourceIds: ["L", "M"] }] },
    );
  });

  it("leaves closed transactionals alone", () => {
    expect(
      inadmissibleSourcePlan(
        sourceMap,
        ["L"],
        [{ id: "T2", status: "withdrawn" as const }],
      ),
    ).toEqual({ drop: [], lapse: [] });
  });
});

describe("transactionalsToClose", () => {
  // T1 groups A and B, T2 groups B, T3 groups C, T4 groups T1 (it replaced
  // its sources, so it can be grouped).
  const sourceMap = buildSourceMap([
    { transactionalId: "t1", sourceId: "a" },
    { transactionalId: "t1", sourceId: "b" },
    { transactionalId: "t2", sourceId: "b" },
    { transactionalId: "t3", sourceId: "c" },
    { transactionalId: "t4", sourceId: "t1" },
  ]);
  const submitted = (id: string) => ({ id, status: "submitted" as const });

  it("closes the pending transactionals over a settled amendment", () => {
    const candidates = competingTransactionalIds(sourceMap, null, ["b"]).map(
      submitted,
    );
    expect(transactionalsToClose(sourceMap, ["b"], candidates)).toEqual([
      { id: "t1", sourceId: "b" },
      { id: "t2", sourceId: "b" },
    ]);
  });

  it("names the first settled amendment each one groups", () => {
    expect(
      transactionalsToClose(sourceMap, ["b", "a"], [submitted("t1")]),
    ).toEqual([{ id: "t1", sourceId: "a" }]);
  });

  it("closes a transactional over another one that was settled", () => {
    expect(transactionalsToClose(sourceMap, ["t1"], [submitted("t4")])).toEqual(
      [{ id: "t4", sourceId: "t1" }],
    );
  });

  it("leaves alone what is no longer submitted or groups nothing settled", () => {
    expect(
      transactionalsToClose(
        sourceMap,
        ["b"],
        [
          { id: "t1", status: "withdrawn" },
          { id: "t2", status: "lapsed" },
          submitted("t3"),
        ],
      ),
    ).toEqual([]);
  });

  it("never closes the amendments being settled themselves", () => {
    // Declaring T1 and B inadmissible at once: T1 is settled, not closed.
    expect(
      transactionalsToClose(
        sourceMap,
        ["t1", "b"],
        [submitted("t1"), submitted("t2"), submitted("t4")],
      ),
    ).toEqual([
      { id: "t2", sourceId: "b" },
      { id: "t4", sourceId: "t1" },
    ]);
  });

  it("lists each transactional once", () => {
    expect(
      transactionalsToClose(
        sourceMap,
        ["a", "b"],
        [submitted("t1"), submitted("t1")],
      ),
    ).toEqual([{ id: "t1", sourceId: "a" }]);
  });
});

describe("transactionalsToRestore", () => {
  // T1 groups A and B, T2 groups B, T3 groups C.
  const sourceMap = buildSourceMap([
    { transactionalId: "t1", sourceId: "a" },
    { transactionalId: "t1", sourceId: "b" },
    { transactionalId: "t2", sourceId: "b" },
    { transactionalId: "t3", sourceId: "c" },
  ]);
  const settledAt = new Date("2026-11-10T10:00:00Z");
  const validatedAt = new Date("2026-11-01T10:00:00Z");
  const open: RestoreRow = {
    status: "submitted",
    admission: "admitted",
    validatedAt,
    decidedAt: null,
  };
  const closed: RestoreRow = {
    status: "withdrawn",
    admission: "admitted",
    validatedAt,
    decidedAt: settledAt,
  };
  const approved: RestoreRow = {
    ...closed,
    status: "approved",
    decidedAt: new Date("2026-11-10T12:00:00Z"),
  };
  const closedBy = (sourceId: string) => ({
    by: "sources_closed",
    sourceId,
    sourceCode: "CEUM 4",
    sourceStatus: "approved",
  });
  const pendingParty = (amendmentId: string) => ({
    amendmentId,
    role: "author" as const,
    decision: "pending" as const,
  });
  // A was incorporated (closing T1) and is undecided again.
  const input = (
    overrides: Partial<Parameters<typeof transactionalsToRestore>[0]> = {},
  ) => ({
    sourceMap,
    reopened: ["a"],
    rows: new Map<string, RestoreRow>([
      ["a", open],
      ["b", open],
      ["t1", closed],
    ]),
    withdrawals: new Map([["t1", closedBy("a")]]),
    parties: [pendingParty("t1")],
    ...overrides,
  });

  it("brings back the transactional the reopened amendment closed", () => {
    expect(transactionalsToRestore(input())).toEqual([
      { id: "t1", sourceId: "a" },
    ]);
  });

  it("waits while another amendment it groups is still settled", () => {
    expect(
      transactionalsToRestore(
        input({
          rows: new Map<string, RestoreRow>([
            ["a", open],
            ["b", approved],
            ["t1", closed],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it("brings it back whichever of its amendments is reopened last", () => {
    // A's settling closed T1; B was approved later, in its own request.
    // Reopening A first: B still settled, T1 waits. Then B: everything T1
    // groups is open, and it comes back naming B.
    expect(
      transactionalsToRestore(
        input({
          rows: new Map<string, RestoreRow>([
            ["a", open],
            ["b", approved],
            ["t1", closed],
          ]),
        }),
      ),
    ).toEqual([]);
    expect(transactionalsToRestore(input({ reopened: ["b"] }))).toEqual([
      { id: "t1", sourceId: "b" },
    ]);
    // The other way round: B first (A still settled), then A.
    expect(
      transactionalsToRestore(
        input({
          reopened: ["b"],
          rows: new Map<string, RestoreRow>([
            ["a", { ...closed, status: "approved" }],
            ["b", open],
            ["t1", closed],
          ]),
        }),
      ),
    ).toEqual([]);
    expect(transactionalsToRestore(input())).toEqual([
      { id: "t1", sourceId: "a" },
    ]);
  });

  it("names the amendment its event names when several reopen at once", () => {
    // A rule change takes A and B out of the text together.
    expect(transactionalsToRestore(input({ reopened: ["b", "a"] }))).toEqual([
      { id: "t1", sourceId: "a" },
    ]);
    expect(
      transactionalsToRestore(
        input({
          reopened: ["b", "a"],
          withdrawals: new Map([["t1", closedBy("c")]]),
        }),
      ),
    ).toEqual([{ id: "t1", sourceId: "a" }]);
  });

  it("keeps closed one a main author rejected", () => {
    expect(
      transactionalsToRestore(
        input({
          parties: [{ ...pendingParty("t1"), decision: "rejected" as const }],
        }),
      ),
    ).toEqual([]);
  });

  it("keeps closed one withdrawn for another reason", () => {
    // Its proposer withdrew it, the Mesa did, or a main author turned it
    // down; or nothing tells why.
    for (const withdrawal of [
      { by: "author" },
      { by: "moderator" },
      { by: "author_rejection" },
    ]) {
      expect(
        transactionalsToRestore(
          input({ withdrawals: new Map([["t1", withdrawal]]) }),
        ),
      ).toEqual([]);
    }
    expect(transactionalsToRestore(input({ withdrawals: new Map() }))).toEqual(
      [],
    );
    // Lapsed because another transactional replaced the same amendments.
    expect(
      transactionalsToRestore(
        input({
          rows: new Map<string, RestoreRow>([
            ["a", open],
            ["b", open],
            ["t1", { ...closed, status: "lapsed" as const }],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it("never brings back one whose amendments are not all open", () => {
    // B was replaced by another transactional (transacted): T1 can never
    // go through, whatever its parties answered.
    expect(
      transactionalsToRestore(
        input({
          rows: new Map<string, RestoreRow>([
            ["a", open],
            ["b", { ...closed, status: "transacted" as const }],
            ["t1", closed],
          ]),
          parties: [{ ...pendingParty("t1"), decision: "accepted" as const }],
        }),
      ),
    ).toEqual([]);
  });

  it("needs every amendment it groups locked, and a dated closure", () => {
    expect(
      transactionalsToRestore(
        input({
          rows: new Map<string, RestoreRow>([
            ["a", open],
            ["t1", closed],
          ]),
        }),
      ),
    ).toEqual([]);
    expect(
      transactionalsToRestore(
        input({
          rows: new Map<string, RestoreRow>([
            ["a", open],
            ["b", open],
            ["t1", { ...closed, decidedAt: null }],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  it("locks the transactionals over the reopened ones and what they group", () => {
    expect(transactionalsOverIds(sourceMap, ["a"])).toEqual(["t1"]);
    expect(transactionalsOverIds(sourceMap, ["b", "t1"])).toEqual(["t2"]);
    expect(restoreLockIds(sourceMap, ["a"])).toEqual(["b", "t1"]);
    expect(restoreLockIds(sourceMap, ["b"])).toEqual(["a", "t1", "t2"]);
  });
});

describe("proposedAcceptanceLockIds", () => {
  // T1 groups A and L, T2 groups L, T3 groups A and T1, T4 groups B alone.
  const sourceMap = buildSourceMap([
    { transactionalId: "T1", sourceId: "A" },
    { transactionalId: "T1", sourceId: "L" },
    { transactionalId: "T2", sourceId: "L" },
    { transactionalId: "T3", sourceId: "A" },
    { transactionalId: "T3", sourceId: "T1" },
    { transactionalId: "T4", sourceId: "B" },
  ]);

  it("locks the transactional, its parents and what competes with it", () => {
    // T2 and T3 share a parent with T1, and T3 also groups T1 itself.
    expect(proposedAcceptanceLockIds(sourceMap, ["T1"])).toEqual([
      "A",
      "L",
      "T1",
      "T2",
      "T3",
    ]);
    expect(proposedAcceptanceLockIds(sourceMap, ["T4"])).toEqual(["B", "T4"]);
  });

  it("joins several without repeats, in id order", () => {
    expect(proposedAcceptanceLockIds(sourceMap, ["T4", "T2"])).toEqual([
      "B",
      "L",
      "T1",
      "T2",
      "T4",
    ]);
    expect(proposedAcceptanceLockIds(sourceMap, [])).toEqual([]);
  });

  it("after a parent leaves, locks only what is left", () => {
    // L declared inadmissible: T1 goes on with A alone.
    const after = buildSourceMap([
      { transactionalId: "T1", sourceId: "A" },
      { transactionalId: "T2", sourceId: "L" },
      { transactionalId: "T3", sourceId: "A" },
    ]);
    expect(proposedAcceptanceLockIds(after, ["T1"])).toEqual(["A", "T1", "T3"]);
  });
});

describe("rowsAfterReopen", () => {
  const settledAt = new Date("2026-11-10T10:00:00Z");
  const row = (id: string, status: RestoreRow["status"]) => ({
    id,
    code: id.toUpperCase(),
    status,
    admission: "inadmissible" as const,
    validatedAt: null,
    decidedAt: settledAt,
  });

  it("shows the reopened ones undecided and the others as locked", () => {
    const rows = rowsAfterReopen(
      [row("a", "inadmissible"), row("t1", "withdrawn")],
      ["a"],
      { admission: "admitted" },
    );
    expect(rows.get("a")).toEqual({
      status: "submitted",
      admission: "admitted",
      validatedAt: null,
      decidedAt: null,
    });
    expect(rows.get("t1")).toEqual({
      status: "withdrawn",
      admission: "inadmissible",
      validatedAt: null,
      decidedAt: settledAt,
    });
  });

  it("ignores a reopened id that was not locked", () => {
    expect([...rowsAfterReopen([row("a", "approved")], ["b"]).keys()]).toEqual([
      "a",
    ]);
  });
});

describe("latestByEntity", () => {
  it("keeps the first row of each entity, the newest", () => {
    expect(
      latestByEntity([
        { entityId: "t1", payload: { by: "sources_closed" } },
        { entityId: "t1", payload: { by: "author" } },
        { entityId: "t2", payload: { by: "moderator" } },
      ]),
    ).toEqual(
      new Map([
        ["t1", { by: "sources_closed" }],
        ["t2", { by: "moderator" }],
      ]),
    );
  });
});

describe("reopenTransactionalsClosedBy", () => {
  // T1 groups A and B, T2 groups A; A is reopened.
  const sourceMap = buildSourceMap([
    { transactionalId: "t1", sourceId: "a" },
    { transactionalId: "t1", sourceId: "b" },
    { transactionalId: "t2", sourceId: "a" },
  ]);
  const settledAt = new Date("2026-11-10T10:00:00Z");
  const row = (id: string, status: RestoreRow["status"]) => ({
    id,
    status,
    admission: "admitted" as const,
    validatedAt: settledAt,
    decidedAt: status === "submitted" ? null : settledAt,
  });
  const actor = { user: { id: "u1" } } as unknown as Actor;

  /** A transaction stub: the events it reads, the ids its update returns. */
  function stubTx(
    withdrawals: { entityId: string; payload: Record<string, unknown> }[],
    returned: string[],
  ) {
    const set = vi.fn();
    const update = vi.fn(() => ({
      set: (values: unknown) => {
        set(values);
        return {
          where: () => ({
            returning: async () => returned.map((id) => ({ id })),
          }),
        };
      },
    }));
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: async () => withdrawals }) }),
      }),
      update,
    };
    return {
      tx: tx as unknown as Parameters<typeof reopenTransactionalsClosedBy>[0],
      update,
      set,
    };
  }

  const input = (
    locked: ReturnType<typeof row>[],
  ): Parameters<typeof reopenTransactionalsClosedBy>[1] => ({
    assemblyId: "as1",
    documentId: "d1",
    actor,
    sourceMap,
    reopened: [{ id: "a", code: "CEUM 4" }],
    // A as it was locked, before the reopening.
    locked,
    parties: [],
  });

  it("brings back what it may and records it", async () => {
    vi.mocked(recordEvent).mockClear();
    // T1's latest withdrawal is the automatic one, an older one was its
    // proposer's; T2 was withdrawn by the Mesa.
    const { tx, set } = stubTx(
      [
        { entityId: "t1", payload: { by: "sources_closed", sourceId: "a" } },
        { entityId: "t1", payload: { by: "author" } },
        { entityId: "t2", payload: { by: "moderator" } },
      ],
      ["t1"],
    );
    const restored = await reopenTransactionalsClosedBy(
      tx,
      input([
        row("a", "approved"),
        row("b", "submitted"),
        row("t1", "withdrawn"),
        row("t2", "withdrawn"),
      ]),
    );
    expect(restored).toEqual(["t1"]);
    expect(set).toHaveBeenCalledWith({ status: "submitted", decidedAt: null });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(tx, {
      assemblyId: "as1",
      documentId: "d1",
      entityType: "amendment",
      entityId: "t1",
      type: "amendment_reopened",
      payload: {
        previousStatus: "withdrawn",
        reason: "source_reopened",
        sourceId: "a",
        sourceCode: "CEUM 4",
      },
      actor,
    });
  });

  it("records nothing for one the update did not change", async () => {
    vi.mocked(recordEvent).mockClear();
    const { tx } = stubTx(
      [{ entityId: "t1", payload: { by: "sources_closed", sourceId: "a" } }],
      [],
    );
    expect(
      await reopenTransactionalsClosedBy(
        tx,
        input([
          row("a", "approved"),
          row("b", "submitted"),
          row("t1", "withdrawn"),
        ]),
      ),
    ).toEqual([]);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("writes nothing when nothing over it is withdrawn", async () => {
    vi.mocked(recordEvent).mockClear();
    const { tx, update } = stubTx([], []);
    expect(
      await reopenTransactionalsClosedBy(
        tx,
        input([
          row("a", "approved"),
          row("b", "submitted"),
          row("t1", "submitted"),
          row("t2", "lapsed"),
        ]),
      ),
    ).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

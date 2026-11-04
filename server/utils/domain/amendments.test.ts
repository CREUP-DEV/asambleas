import { describe, expect, it, vi } from "vitest";
import type { AmendmentOp, Block } from "../../../shared/types/content";

// Only the pure helpers are tested here: stub every module that touches the
// database or relies on Nuxt aliases. h3 is a Nitro dependency, not a direct
// one, so its error helper is stubbed with the same shape.
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
  canModerate: vi.fn(),
  canReviewAmendments: vi.fn(),
  requireActor: vi.fn(),
}));
vi.mock("./documents", () => ({ loadMilestones: vi.fn() }));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));
vi.mock("./resolvers", () => ({
  resolveAmendment: vi.fn(),
  resolveAssembly: vi.fn(),
  resolveDocument: vi.fn(),
}));
vi.mock("./visibility", () => ({
  canSeeAmendment: vi.fn(),
  canSeePositions: vi.fn(),
  isDocumentProponent: vi.fn(),
}));
vi.mock("../errors", () => ({ isUniqueConstraintViolation: vi.fn() }));

const {
  amendmentCapabilities,
  amendmentSortKey,
  buildAcceptanceParties,
  computeApprovalWarnings,
  evaluateVoteInput,
  insertedBlockIds,
  nextTransactionalCode,
  prepareAmendmentOps,
  reIdInsertedBlocks,
  redactAmendmentEventPayload,
} = await import("./amendments");

const block = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const base: Block[] = [
  block("b1", "Primer párrafo del texto."),
  block("b2", "Segundo párrafo del texto."),
  block("b3", "Tercer párrafo del texto."),
];

const replace = (
  blockId: string,
  from: number,
  to: number,
  text: string,
): AmendmentOp => {
  const source = base.find((item) => item.id === blockId)!;
  return {
    op: "replace",
    blockId,
    from,
    to,
    text,
    baseText: source.text.slice(from, to),
  };
};

function sequence(...ids: string[]) {
  let index = 0;
  return () => ids[index++] ?? `generated${index}`;
}

describe("reIdInsertedBlocks", () => {
  it("keeps fresh ids and renames those taken by the base or other amendments", () => {
    const ops: AmendmentOp[] = [
      {
        op: "insert",
        afterBlockId: "b1",
        blocks: [block("b2", "Nuevo"), block("n1", "Otro")],
      },
      { op: "insert", afterBlockId: "b3", blocks: [block("other1", "Más")] },
    ];
    const result = reIdInsertedBlocks(
      ops,
      base,
      ["other1"],
      sequence("x1", "x2"),
    );
    expect(insertedBlockIds(result)).toEqual(["x1", "n1", "x2"]);
    // Text and anchors are untouched.
    expect(result[0]).toMatchObject({ afterBlockId: "b1" });
    expect((result[0] as { blocks: Block[] }).blocks[0]!.text).toBe("Nuevo");
  });

  it("renames duplicates within the same operations", () => {
    const ops: AmendmentOp[] = [
      {
        op: "insert",
        afterBlockId: null,
        blocks: [block("dup1", "A"), block("dup1", "B")],
      },
    ];
    const result = reIdInsertedBlocks(ops, base, [], sequence("fresh1"));
    expect(insertedBlockIds(result)).toEqual(["dup1", "fresh1"]);
  });

  it("skips generated ids that are already taken", () => {
    const ops: AmendmentOp[] = [
      { op: "insert", afterBlockId: "b1", blocks: [block("b1", "A")] },
    ];
    const result = reIdInsertedBlocks(
      ops,
      base,
      [],
      sequence("b2", "b3", "ok1"),
    );
    expect(insertedBlockIds(result)).toEqual(["ok1"]);
  });

  it("leaves replace and delete operations alone", () => {
    const ops: AmendmentOp[] = [
      replace("b1", 0, 6, "Inicial"),
      { op: "delete", blockIds: ["b2"] },
    ];
    expect(reIdInsertedBlocks(ops, base, [])).toEqual(ops);
  });
});

describe("prepareAmendmentOps", () => {
  it("accepts a devolution with no operations and refuses one with operations", () => {
    expect(
      prepareAmendmentOps({
        kind: "totality_return",
        ops: [],
        base,
        takenIds: [],
      }),
    ).toEqual({
      ops: [],
      errors: [],
    });
    const withOps = prepareAmendmentOps({
      kind: "totality_return",
      ops: [replace("b1", 0, 6, "Inicial")],
      base,
      takenIds: [],
    });
    expect(withOps.errors.map((error) => error.reason)).toEqual([
      "totality_return_ops",
    ]);
  });

  it("requires at least one operation for every other kind", () => {
    for (const kind of [
      "partial",
      "formal",
      "totality_alternative",
      "transactional",
    ] as const) {
      const result = prepareAmendmentOps({ kind, ops: [], base, takenIds: [] });
      expect(result.errors.map((error) => error.reason)).toContain("empty");
    }
  });

  it("reports operations that are not anchored to the base", () => {
    const result = prepareAmendmentOps({
      kind: "partial",
      ops: [{ op: "delete", blockIds: ["missing"] }],
      base,
      takenIds: [],
    });
    expect(result.errors.map((error) => error.reason)).toContain(
      "unknown_block",
    );
  });

  it("re-ids colliding inserted blocks before validating", () => {
    const result = prepareAmendmentOps({
      kind: "partial",
      ops: [
        {
          op: "insert",
          afterBlockId: "b2",
          blocks: [block("b3", "Nuevo párrafo")],
        },
      ],
      base,
      takenIds: [],
      newId: sequence("newblock1"),
    });
    expect(result.errors).toEqual([]);
    expect(insertedBlockIds(result.ops)).toEqual(["newblock1"]);
  });
});

describe("amendmentSortKey", () => {
  it("puts totality amendments first", () => {
    const partial = amendmentSortKey(
      "partial",
      [{ op: "insert", afterBlockId: null, blocks: [block("n1", "A")] }],
      base,
    );
    const alternative = amendmentSortKey(
      "totality_alternative",
      [replace("b1", 0, 6, "X")],
      base,
    );
    const devolution = amendmentSortKey("totality_return", [], base);
    expect(devolution).toBeLessThan(alternative);
    expect(alternative).toBeLessThan(partial);
  });

  it("orders partial amendments by where they act", () => {
    const first = amendmentSortKey("partial", [replace("b1", 0, 6, "X")], base);
    const third = amendmentSortKey(
      "partial",
      [{ op: "delete", blockIds: ["b3"] }],
      base,
    );
    expect(first).toBeLessThan(third);
  });
});

describe("buildAcceptanceParties", () => {
  it("adds every distinct source author and the proponent, accepting the creator", () => {
    expect(buildAcceptanceParties(["m1", "m2", "m1"], "p1", "m2")).toEqual([
      { memberId: "m1", role: "author", accepted: false },
      { memberId: "m2", role: "author", accepted: true },
      { memberId: "p1", role: "proponent", accepted: false },
    ]);
  });

  it("keeps a single row when the proponent also authored a source", () => {
    expect(buildAcceptanceParties(["p1"], "p1", null)).toEqual([
      { memberId: "p1", role: "author", accepted: false },
    ]);
  });

  it("works without a proponent", () => {
    expect(buildAcceptanceParties(["m1"], null, "m1")).toEqual([
      { memberId: "m1", role: "author", accepted: true },
    ]);
  });
});

describe("nextTransactionalCode", () => {
  it("numbers transactionals per document", () => {
    expect(nextTransactionalCode([])).toBe("T1");
    expect(nextTransactionalCode(["T1", "T2"])).toBe("T3");
  });

  it("skips codes still in use after a draft was deleted", () => {
    expect(nextTransactionalCode(["T2"])).toBe("T3");
  });
});

describe("amendmentCapabilities", () => {
  const input = {
    status: "draft" as const,
    isAuthor: false,
    isProponent: false,
    moderate: false,
    review: false,
    actorMemberId: "m1",
    acceptances: [],
  };

  it("lets authors edit and submit drafts", () => {
    expect(amendmentCapabilities({ ...input, isAuthor: true })).toMatchObject({
      edit: true,
      submit: true,
      withdraw: false,
      position: false,
    });
  });

  it("lets authors withdraw and the proponent position submitted amendments", () => {
    const caps = amendmentCapabilities({
      ...input,
      status: "submitted",
      isAuthor: true,
      isProponent: true,
    });
    expect(caps).toMatchObject({
      edit: false,
      submit: false,
      withdraw: true,
      position: true,
    });
  });

  it("offers acceptance only to a pending party of an open amendment", () => {
    const acceptances = [
      { memberId: "m1", decision: "pending" as const },
      { memberId: "m2", decision: "accepted" as const },
    ];
    expect(
      amendmentCapabilities({ ...input, status: "submitted", acceptances })
        .accept,
    ).toBe(true);
    expect(
      amendmentCapabilities({
        ...input,
        status: "submitted",
        actorMemberId: "m2",
        acceptances,
      }).accept,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...input, status: "approved", acceptances })
        .accept,
    ).toBe(false);
  });

  it("passes the moderation and review flags through", () => {
    const caps = amendmentCapabilities({
      ...input,
      status: "submitted",
      moderate: true,
      review: true,
    });
    expect(caps).toMatchObject({
      moderate: true,
      review: true,
      position: true,
      edit: false,
    });
  });
});

describe("computeApprovalWarnings", () => {
  it("lists approved amendments that collide and incompatible links", () => {
    const target = { id: "a1", ops: [replace("b1", 0, 6, "Inicial")] };
    const approved = [
      { id: "a2", ops: [replace("b1", 2, 10, "otra cosa")] },
      { id: "a3", ops: [replace("b2", 0, 7, "Segundo")] },
      { id: "a1", ops: target.ops },
    ];
    expect(
      computeApprovalWarnings(target, approved, ["a4", "a4", "a1"]),
    ).toEqual({
      overlapsWithApproved: ["a2"],
      incompatible: ["a4"],
    });
  });
});

describe("evaluateVoteInput", () => {
  const settings = {
    denominator: "valid_votes" as const,
    tieRule: "rejected" as const,
  };

  it("defaults to a simple majority", () => {
    const result = evaluateVoteInput(
      { method: "show_of_hands", inFavor: 10, against: 4 },
      settings,
    );
    expect(result.majority).toBe("simple");
    expect(result.outcome.result).toBe("approved");
  });

  it("rejects a tie unless the assembly repeats tied votes", () => {
    const tie = { method: "show_of_hands" as const, inFavor: 5, against: 5 };
    expect(evaluateVoteInput(tie, settings).outcome.result).toBe("rejected");
    let error: unknown;
    try {
      evaluateVoteInput(tie, { ...settings, tieRule: "repeat" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ statusCode: 409, data: { tie: true } });
  });

  it("refuses more votes than members present", () => {
    expect(() =>
      evaluateVoteInput(
        { method: "secret", inFavor: 8, against: 4, present: 10 },
        settings,
      ),
    ).toThrowError(expect.objectContaining({ statusCode: 422 }));
  });

  it("uses the requested majority", () => {
    const result = evaluateVoteInput(
      { method: "roll_call", inFavor: 6, against: 4, majority: "two_thirds" },
      settings,
    );
    expect(result.majority).toBe("two_thirds");
    expect(result.outcome.result).toBe("rejected");
  });
});

describe("redactAmendmentEventPayload", () => {
  it("hides positions from those who cannot see them", () => {
    const payload = { position: "accept", by: "proponent" };
    expect(
      redactAmendmentEventPayload("position_changed", payload, false),
    ).toEqual({});
    expect(
      redactAmendmentEventPayload("position_changed", payload, true),
    ).toEqual(payload);
    expect(
      redactAmendmentEventPayload("amendment_submitted", payload, false),
    ).toEqual(payload);
  });
});

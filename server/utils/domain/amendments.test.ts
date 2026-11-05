import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  canManageAssemblies: vi.fn(),
  canManageDocuments: vi.fn(),
  canModerate: vi.fn(),
  canReviewAmendments: vi.fn(),
  requireActor: vi.fn(),
  UNLINKED_ACCOUNT_MESSAGE: "Tu cuenta no está vinculada a ningún miembro",
}));
vi.mock("./documents", () => ({
  assemblySettings: vi.fn(),
  clearLiveVote: vi.fn(),
  loadMilestones: vi.fn(),
  pointLiveVote: vi.fn(),
  shareLockAssembly: vi.fn(),
}));
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
  redactCorrectionNote: vi.fn(),
}));
vi.mock("../errors", () => ({ isUniqueConstraintViolation: vi.fn() }));

const {
  admissionEligible,
  amendmentCapabilities,
  amendmentSortKey,
  buildAcceptanceParties,
  buildSourceMap,
  collectAncestors,
  computeApprovalWarnings,
  evaluateVoteInput,
  insertedBlockIds,
  lineageToRestore,
  nextTransactionalCode,
  prepareAmendmentOps,
  reIdInsertedBlocks,
  redactAmendmentEventPayload,
  requestedDraftAuthorIds,
  unauthorizedTransactionalAuthors,
} = await import("./amendments");
// The visibility rules are pure too; their actor helpers are the stubs above.
const visibility =
  await vi.importActual<typeof import("./visibility")>("./visibility");
const actorHelpers = await import("./actor");

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
    validatedAt: null,
    publishedAt: null,
  };
  const at = new Date("2026-03-10T12:00:00Z");

  it("lets reviewers validate presented amendments not validated yet", () => {
    const pending = { ...input, status: "submitted" as const };
    expect(amendmentCapabilities({ ...pending, review: true })).toMatchObject({
      validate: true,
      publish: false,
    });
    expect(amendmentCapabilities(pending).validate).toBe(false);
    expect(amendmentCapabilities({ ...input, review: true }).validate).toBe(
      false,
    );
  });

  it("lets reviewers publish validated amendments not published yet", () => {
    const validated = {
      ...input,
      status: "submitted" as const,
      review: true,
      validatedAt: at,
    };
    expect(amendmentCapabilities(validated)).toMatchObject({
      validate: false,
      publish: true,
    });
    expect(
      amendmentCapabilities({ ...validated, publishedAt: at }).publish,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...validated, status: "approved" }).publish,
    ).toBe(true);
  });

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

describe("admissionEligible", () => {
  const pending = { status: "submitted", admission: "pending" };
  const admitted = { status: "submitted", admission: "admitted" };
  const inadmissible = { status: "inadmissible", admission: "inadmissible" };
  const approved = { status: "approved", admission: "admitted" };

  it("admits pending and inadmissible amendments only", () => {
    expect(admissionEligible(pending, "admitted")).toBe(true);
    expect(admissionEligible(inadmissible, "admitted")).toBe(true);
    // Already admitted, say by a concurrent decision: a second admission
    // (or a failed vote to admit) must not apply to it.
    expect(admissionEligible(admitted, "admitted")).toBe(false);
    expect(admissionEligible(approved, "admitted")).toBe(false);
  });

  it("declares inadmissible any amendment still submitted", () => {
    expect(admissionEligible(pending, "inadmissible")).toBe(true);
    expect(admissionEligible(admitted, "inadmissible")).toBe(true);
    expect(admissionEligible(inadmissible, "inadmissible")).toBe(false);
    expect(admissionEligible(approved, "inadmissible")).toBe(false);
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

describe("nested transactional lineage", () => {
  // T2 over T1 and C; T1 over A and B; T3 over A.
  const sourceMap = buildSourceMap([
    { transactionalId: "t1", sourceId: "a" },
    { transactionalId: "t1", sourceId: "b" },
    { transactionalId: "t2", sourceId: "t1" },
    { transactionalId: "t2", sourceId: "c" },
    { transactionalId: "t3", sourceId: "a" },
  ]);

  it("groups the sources of each transactional", () => {
    expect(sourceMap.get("t1")).toEqual(["a", "b"]);
    expect(sourceMap.get("a")).toBeUndefined();
  });

  it("collects every absorbed amendment at any depth", () => {
    expect(collectAncestors(sourceMap, ["t2"])).toEqual(["t1", "c", "a", "b"]);
    expect(collectAncestors(sourceMap, ["t1", "c"])).toEqual(["a", "b"]);
    expect(collectAncestors(sourceMap, ["a"])).toEqual([]);
  });

  it("survives cycles", () => {
    const cyclic = buildSourceMap([
      { transactionalId: "x", sourceId: "y" },
      { transactionalId: "y", sourceId: "x" },
    ]);
    expect(collectAncestors(cyclic, ["x"])).toEqual(["y", "x"]);
  });

  it("restores the whole lineage on reopen", () => {
    expect(lineageToRestore(sourceMap, "t2", []).sort()).toEqual([
      "a",
      "b",
      "c",
      "t1",
    ]);
  });

  it("keeps what another approved transactional still absorbs", () => {
    expect(lineageToRestore(sourceMap, "t2", ["t3"]).sort()).toEqual([
      "b",
      "c",
      "t1",
    ]);
    // The reopened transactional itself never counts as another one.
    expect(lineageToRestore(sourceMap, "t2", ["t2"]).sort()).toEqual([
      "a",
      "b",
      "c",
      "t1",
    ]);
  });
});

describe("requestedDraftAuthorIds", () => {
  const input = {
    authorMemberIds: ["p"],
    onBehalfOfMemberId: undefined,
    actorMemberId: "b",
    presentingMemberId: "p",
    currentAuthorIds: ["p", "b"],
  };

  it("keeps a co-author who edits a draft presented by another member", () => {
    expect(requestedDraftAuthorIds(input)).toEqual(["p", "b"]);
  });

  it("leaves the request alone otherwise", () => {
    expect(
      requestedDraftAuthorIds({ ...input, authorMemberIds: undefined }),
    ).toBeUndefined();
    // resolveDraftAuthors always keeps the presenting member.
    expect(requestedDraftAuthorIds({ ...input, actorMemberId: "p" })).toEqual([
      "p",
    ]);
    // Not an author: a reviewer or the Mesa editing.
    expect(
      requestedDraftAuthorIds({ ...input, currentAuthorIds: ["p"] }),
    ).toEqual(["p"]);
    expect(
      requestedDraftAuthorIds({ ...input, onBehalfOfMemberId: "q" }),
    ).toEqual(["p"]);
    expect(requestedDraftAuthorIds({ ...input, actorMemberId: null })).toEqual([
      "p",
    ]);
  });

  it("does not duplicate the actor", () => {
    expect(
      requestedDraftAuthorIds({ ...input, authorMemberIds: ["b", "p"] }),
    ).toEqual(["b", "p"]);
  });
});

describe("unauthorizedTransactionalAuthors", () => {
  const input = {
    actorMemberId: "me",
    currentAuthorIds: ["me", "old"],
    partyMemberIds: ["a1", "a2", null],
  };

  it("accepts the actor, current authors and the parties", () => {
    expect(
      unauthorizedTransactionalAuthors(["me", "old", "a1", "a2"], input),
    ).toEqual([]);
  });

  it("lists anyone else", () => {
    expect(
      unauthorizedTransactionalAuthors(["me", "stranger", "a1"], input),
    ).toEqual(["stranger"]);
  });
});

describe("visibility", () => {
  const { canSeeAmendment, canSeeDocument } = visibility;
  type Actor = Parameters<typeof canSeeAmendment>[0];
  type AmendmentInput = Parameters<typeof canSeeAmendment>[1];
  type DocumentInput = Parameters<typeof canSeeDocument>[1];
  type Role = "member" | "moderator" | "reviewer" | "manager";

  const actor = (role: Role, memberId: string | null = "m1") =>
    ({ user: { id: `user-${role}` }, memberId, role }) as unknown as Actor;
  const roleOf = (value: Actor) => (value as unknown as { role: Role }).role;

  beforeAll(() => {
    vi.mocked(actorHelpers.actsFor).mockImplementation((who, ids) =>
      Boolean(who.memberId && ids.includes(who.memberId)),
    );
    vi.mocked(actorHelpers.canModerate).mockImplementation(
      (who) => roleOf(who) === "moderator",
    );
    vi.mocked(actorHelpers.canReviewAmendments).mockImplementation((who) =>
      ["reviewer", "manager"].includes(roleOf(who)),
    );
    vi.mocked(actorHelpers.canManageDocuments).mockImplementation(
      (who) => roleOf(who) === "manager",
    );
  });

  afterAll(() => {
    vi.mocked(actorHelpers.actsFor).mockReset();
    vi.mocked(actorHelpers.canModerate).mockReset();
    vi.mocked(actorHelpers.canReviewAmendments).mockReset();
    vi.mocked(actorHelpers.canManageDocuments).mockReset();
  });

  describe("canSeeAmendment", () => {
    const publishedAt = new Date("2026-03-10T12:00:00Z");
    const amendment = (
      status: AmendmentInput["status"],
      extra: Partial<AmendmentInput> = {},
    ): AmendmentInput => ({
      status,
      publishedAt: null,
      createdByUserId: "user-author",
      authorMemberIds: ["author"],
      partyMemberIds: [],
      ...extra,
    });

    it("hides presented amendments until the Secretaría publishes them", () => {
      for (const status of [
        "submitted",
        "withdrawn",
        "inadmissible",
        "lapsed",
      ] as const) {
        expect(canSeeAmendment(actor("member"), amendment(status))).toBe(false);
        expect(
          canSeeAmendment(actor("member", "author"), amendment(status)),
        ).toBe(true);
        for (const role of ["moderator", "reviewer", "manager"] as const) {
          expect(canSeeAmendment(actor(role), amendment(status))).toBe(true);
        }
      }
    });

    it("shows published amendments to everyone", () => {
      expect(
        canSeeAmendment(
          actor("member"),
          amendment("submitted", { publishedAt }),
        ),
      ).toBe(true);
      expect(
        canSeeAmendment(
          actor("member"),
          amendment("approved", { publishedAt }),
        ),
      ).toBe(true);
    });

    it("shows a transactional to its parties and its creator", () => {
      expect(
        canSeeAmendment(
          actor("member", "party"),
          amendment("submitted", { partyMemberIds: ["party"] }),
        ),
      ).toBe(true);
      expect(
        canSeeAmendment(
          actor("member", null),
          amendment("submitted", { createdByUserId: "user-member" }),
        ),
      ).toBe(true);
    });

    it("keeps drafts from the Mesa alone, even returned for correction", () => {
      expect(canSeeAmendment(actor("moderator"), amendment("draft"))).toBe(
        false,
      );
      expect(canSeeAmendment(actor("reviewer"), amendment("draft"))).toBe(true);
      expect(
        canSeeAmendment(
          actor("moderator"),
          amendment("draft", { createdByUserId: "user-moderator" }),
        ),
      ).toBe(true);
      expect(canSeeAmendment(actor("member"), amendment("draft"))).toBe(false);
    });
  });

  describe("seesAllPresentedAmendments", () => {
    const { seesAllPresentedAmendments } = visibility;

    it("is true only for the Secretaría and the Mesa", () => {
      expect(seesAllPresentedAmendments(actor("member"))).toBe(false);
      for (const role of ["moderator", "reviewer", "manager"] as const) {
        expect(seesAllPresentedAmendments(actor(role))).toBe(true);
      }
    });
  });

  describe("redactCorrectionNote", () => {
    const { redactCorrectionNote } = visibility;
    const payload = { note: "Corrige la justificación", other: 1 };

    it("removes the note of correction events for others", () => {
      for (const type of [
        "document_correction_requested",
        "amendment_correction_requested",
      ]) {
        expect(redactCorrectionNote(type, payload, false)).toEqual({
          other: 1,
        });
        expect(redactCorrectionNote(type, payload, true)).toBe(payload);
      }
    });

    it("leaves other events alone", () => {
      expect(redactCorrectionNote("decision_recorded", payload, false)).toBe(
        payload,
      );
    });
  });

  describe("decisions", () => {
    const { decisionAmendmentIds, filterDecisionsByAmendment } = visibility;
    type Decision = Parameters<typeof filterDecisionsByAmendment>[0][number];
    const decision = (
      id: string,
      kind: Decision["kind"],
      subjectIds: string[],
    ): Decision => ({
      id,
      kind,
      method: "mesa",
      subjectIds,
      note: `nota ${id}`,
      vote: null,
      decidedAt: "2026-03-10T12:00:00.000Z",
    });
    const list = [
      decision("d1", "inadmission", ["hidden"]),
      decision("d2", "admit_late", ["hidden", "mine"]),
      decision("d3", "agenda_change", ["item"]),
      decision("d4", "inadmission", ["mine"]),
    ];
    const isVisible = (id: string) => id === "mine";

    it("collects only the amendment ids of admission decisions", () => {
      expect(decisionAmendmentIds(list)).toEqual(["hidden", "mine"]);
    });

    it("drops decisions that name only hidden amendments", () => {
      const result = filterDecisionsByAmendment(list, isVisible);
      expect(result.map((item) => item.id)).toEqual(["d2", "d3", "d4"]);
    });

    it("keeps the visible subjects and the note of mixed decisions", () => {
      const [mixed] = filterDecisionsByAmendment(list, isVisible);
      expect(mixed).toMatchObject({
        id: "d2",
        subjectIds: ["mine"],
        note: "nota d2",
      });
    });

    it("leaves other kinds and fully visible decisions untouched", () => {
      const result = filterDecisionsByAmendment(list, isVisible);
      expect(result[1]).toBe(list[2]);
      expect(result[2]).toBe(list[3]);
    });
  });

  describe("canSeeDocument", () => {
    const document = (status: DocumentInput["status"]): DocumentInput => ({
      status,
      proponentMemberId: "proponent",
      submittedByUserId: "user-proponent",
    });

    it("keeps drafts from the Mesa but shows it submissions", () => {
      expect(canSeeDocument(actor("moderator"), document("draft"))).toBe(false);
      expect(canSeeDocument(actor("moderator"), document("submitted"))).toBe(
        true,
      );
      expect(canSeeDocument(actor("manager"), document("draft"))).toBe(true);
      expect(
        canSeeDocument(actor("member", "proponent"), document("draft")),
      ).toBe(true);
      expect(canSeeDocument(actor("member"), document("published"))).toBe(true);
    });
  });
});

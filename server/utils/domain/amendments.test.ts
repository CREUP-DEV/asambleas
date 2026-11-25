import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { amendmentCodePrefix } from "../../../shared/utils/amendmentCode";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import {
  amendmentVoteMajority,
  DOCUMENT_KIND_DEFAULTS,
  GENERIC_EXECUTIVE_MEMBER_ID,
  REGULATION_DOCUMENT_KINDS,
} from "../../../shared/constants/domain";

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
  canRecordResults: vi.fn(),
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
  isDocumentPresenter: vi.fn(),
  isDocumentProponent: vi.fn(),
  redactCorrectionNote: vi.fn(),
}));
vi.mock("../errors", () => ({ isUniqueConstraintViolation: vi.fn() }));

const {
  acceptanceRecordedBy,
  admissionEligible,
  amendmentCapabilities,
  amendmentSortKey,
  buildAcceptanceParties,
  canProposeTransactional,
  collectApprovalWarnings,
  composerAuthorsAccess,
  computeApprovalWarnings,
  evaluateVoteInput,
  insertedBlockIds,
  nextTransactionalCode,
  prepareAmendmentOps,
  reIdInsertedBlocks,
  redactAmendmentEventPayload,
  requestedDraftAuthorIds,
  sourcesAreOpen,
  toPositionDto,
  sourcesToReplace,
  canReviseTransactional,
  revisionAfterAnswers,
  transactionalsShareSources,
  unauthorizedTransactionalAuthors,
  withdrawAmendment,
  withdrawNeedsMesa,
  REPLACED_SOURCES_WITHDRAW_MESSAGE,
} = await import("./amendments");
const {
  applyAmendmentOutcome,
  assertAlternativesUnderLock,
  lockOpenSession,
  touchVotedWithoutEffect,
} = await import("./amendments");
const documentsModule = await import("./documents");
const { db: stubDb } = await import("../../db");
const { buildSourceMap, competingTransactionalIds } =
  await import("./transactionalClosure");
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
  it("requires at least one operation", () => {
    const result = prepareAmendmentOps({ ops: [], base, takenIds: [] });
    expect(result.errors.map((error) => error.reason)).toContain("empty");
  });

  it("reports operations that are not anchored to the base", () => {
    const result = prepareAmendmentOps({
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
  it("orders amendments by where they act", () => {
    const first = amendmentSortKey([replace("b1", 0, 6, "X")], base);
    const third = amendmentSortKey([{ op: "delete", blockIds: ["b3"] }], base);
    expect(first).toBeLessThan(third);
  });
});

describe("buildAcceptanceParties", () => {
  it("asks every distinct main author, accepting the creator", () => {
    expect(buildAcceptanceParties(["m1", "m2", "m1"], "m2")).toEqual([
      { memberId: "m1", role: "author", accepted: false },
      { memberId: "m2", role: "author", accepted: true },
    ]);
  });

  it("skips sources without a main author", () => {
    expect(buildAcceptanceParties([null, "m1"], null)).toEqual([
      { memberId: "m1", role: "author", accepted: false },
    ]);
    expect(buildAcceptanceParties([null], null)).toEqual([]);
  });
});

describe("canProposeTransactional", () => {
  const input = {
    moderate: false,
    canCreate: true,
    actorMemberId: "m1",
    isParty: false,
    anyone: false,
  };

  it("lets only the parties propose one by default (2026-11-20)", () => {
    expect(canProposeTransactional(input)).toBe(false);
    expect(canProposeTransactional({ ...input, isParty: true })).toBe(true);
    expect(
      canProposeTransactional({ ...input, canCreate: false, isParty: true }),
    ).toBe(true);
  });

  it("lets any member that presents amendments when the assembly opens it", () => {
    expect(canProposeTransactional({ ...input, anyone: true })).toBe(true);
    expect(
      canProposeTransactional({ ...input, anyone: true, canCreate: false }),
    ).toBe(false);
  });

  it("needs a member, except for the Mesa", () => {
    expect(canProposeTransactional({ ...input, actorMemberId: null })).toBe(
      false,
    );
    expect(
      canProposeTransactional({
        moderate: true,
        canCreate: false,
        actorMemberId: null,
        isParty: false,
        anyone: false,
      }),
    ).toBe(true);
  });
});

describe("amendmentCodePrefix", () => {
  it("codes a council's or a sectorial's amendments with its acronym", () => {
    expect(amendmentCodePrefix({ acronym: "CEUM", kind: "asociado" })).toBe(
      "CEUM",
    );
    expect(amendmentCodePrefix({ acronym: "CEET", kind: "sectorial" })).toBe(
      "CEET",
    );
    expect(amendmentCodePrefix({ acronym: "INV", kind: "other" })).toBe("INV");
  });

  it("codes every executive area's amendments as CEA, never with its acronym", () => {
    expect(amendmentCodePrefix({ acronym: "VPU", kind: "executive" })).toBe(
      "CEA",
    );
    expect(amendmentCodePrefix({ acronym: "TES", kind: "executive" })).toBe(
      "CEA",
    );
  });
});

describe("nextTransactionalCode", () => {
  it("numbers transactionals per document", () => {
    expect(nextTransactionalCode([])).toBe("T1");
    expect(nextTransactionalCode(["T1", "T2"])).toBe("T3");
  });

  it("never gives again a number once taken, also by one deleted", () => {
    expect(nextTransactionalCode(["T2"])).toBe("T3");
    // The same code recorded by several events counts once.
    expect(nextTransactionalCode(["T1", "T1", "T1"])).toBe("T2");
  });

  it("reads codes from before, with a space, and ignores member codes", () => {
    expect(nextTransactionalCode(["T 4", "UGR7"])).toBe("T5");
  });

  it("does not count drafts (no code)", () => {
    expect(nextTransactionalCode([null, "T1", null])).toBe("T2");
    expect(nextTransactionalCode([null])).toBe("T1");
  });
});

describe("amendmentCapabilities", () => {
  const input = {
    status: "draft" as const,
    admission: "pending" as const,
    approvalMethod: null,
    isAuthor: false,
    isPresenter: false,
    moderate: false,
    review: false,
    actorMemberId: "m1",
    acceptances: [],
    validatedAt: null,
    publishedAt: null,
    rule: "vote" as const,
  };
  const at = new Date("2026-03-10T12:00:00Z");
  const admitted = {
    ...input,
    status: "submitted" as const,
    admission: "admitted" as const,
    validatedAt: at,
    publishedAt: at,
  };

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

  it("lets reviewers take back the validation of an undecided amendment", () => {
    const validated = {
      ...input,
      status: "submitted" as const,
      review: true,
      validatedAt: at,
      kind: "partial" as const,
      late: false,
    };
    expect(amendmentCapabilities(validated).unvalidate).toBe(true);
    expect(
      amendmentCapabilities({ ...validated, publishedAt: at }).unvalidate,
    ).toBe(true);
    // Not for those who do not review, nor once decided, voted or closed.
    expect(
      amendmentCapabilities({ ...validated, review: false }).unvalidate,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...validated, status: "approved" }).unvalidate,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...validated, voted: true }).unvalidate,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...validated, assemblyClosed: true }).unvalidate,
    ).toBe(false);
    // Nor while a transactional groups it.
    expect(
      amendmentCapabilities({ ...validated, grouped: true }).unvalidate,
    ).toBe(false);
    // Nor before it is validated.
    expect(
      amendmentCapabilities({ ...validated, validatedAt: null }).unvalidate,
    ).toBe(false);
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

  it("lets authors withdraw and the main presenter answer admitted amendments", () => {
    const caps = amendmentCapabilities({
      ...admitted,
      isAuthor: true,
      isPresenter: true,
    });
    expect(caps).toMatchObject({
      edit: false,
      submit: false,
      withdraw: true,
      position: true,
    });
  });

  describe("withdrawing a transactional that replaced its sources", () => {
    // UAM (m1) presented T3 over UAM 3 and UCM 2 (m2); UCM accepted it and
    // the Secretaría validated it: UAM 3 and UCM 2 are `transacted`.
    const parties = [
      { memberId: "m1", decision: "accepted" as const },
      { memberId: "m2", decision: "accepted" as const },
    ];
    const inForce = {
      ...admitted,
      isAuthor: true,
      authorsApproval: "accepted" as const,
      acceptances: parties,
    };

    it("keeps it for the Mesa once it stands in for other members' amendments", () => {
      expect(withdrawNeedsMesa(inForce)).toBe(true);
      expect(amendmentCapabilities(inForce).withdraw).toBe(false);
      // An author that is also the Mesa may.
      expect(
        amendmentCapabilities({ ...inForce, moderate: true }).withdraw,
      ).toBe(true);
    });

    it("leaves it to its author while it has not replaced anything", () => {
      const waiting = {
        ...inForce,
        authorsApproval: "pending" as const,
        acceptances: [
          parties[0]!,
          { memberId: "m2", decision: "pending" as const },
        ],
      };
      expect(withdrawNeedsMesa(waiting)).toBe(false);
      expect(amendmentCapabilities(waiting).withdraw).toBe(true);
      const unvalidated = { ...inForce, validatedAt: null };
      expect(withdrawNeedsMesa(unvalidated)).toBe(false);
      expect(amendmentCapabilities(unvalidated).withdraw).toBe(true);
    });

    it("leaves it to its author when it groups only that member's amendments", () => {
      const own = { ...inForce, acceptances: [parties[0]!] };
      expect(withdrawNeedsMesa(own)).toBe(false);
      expect(amendmentCapabilities(own).withdraw).toBe(true);
    });

    it("never touches an amendment that is not a transactional", () => {
      const plain = { ...admitted, isAuthor: true, authorsApproval: null };
      expect(withdrawNeedsMesa(plain)).toBe(false);
      expect(amendmentCapabilities(plain).withdraw).toBe(true);
    });

    it("lets the proposer withdraw an older one left behind by another transactional", () => {
      // docs/api.md: one left submitted with a source already closed is never
      // answered again, so its parties never all accept it.
      const leftBehind = {
        ...inForce,
        authorsApproval: "pending" as const,
        acceptances: [{ memberId: "m2", decision: "pending" as const }],
      };
      expect(amendmentCapabilities(leftBehind).withdraw).toBe(true);
    });

    it("refuses the author's withdrawal on the server with a reason", async () => {
      vi.mocked(actorHelpers.canModerate).mockReturnValue(false);
      try {
        const party = (memberId: string) => ({
          memberId,
          role: "author" as const,
          decision: "accepted" as const,
        });
        const ctx = {
          actor: { user: { id: "u1" }, memberId: "m1" },
          isAuthor: true,
          now: at,
          document: { finalVoteId: null, consolidatedVersionId: null },
          amendment: {
            id: "t3",
            kind: "transactional",
            status: "submitted",
            validatedAt: at,
            acceptances: [party("m1"), party("m2")],
          },
        } as unknown as Parameters<typeof withdrawAmendment>[0];
        await expect(withdrawAmendment(ctx)).rejects.toMatchObject({
          statusCode: 409,
          message: REPLACED_SOURCES_WITHDRAW_MESSAGE,
        });
      } finally {
        vi.mocked(actorHelpers.canModerate).mockReset();
      }
    });
  });

  it("waits for the Secretaría and, when late, the assembly before an answer", () => {
    const presenter = {
      ...input,
      status: "submitted" as const,
      isPresenter: true,
    };
    expect(amendmentCapabilities(presenter).position).toBe(false);
    expect(
      amendmentCapabilities({ ...presenter, validatedAt: at }).position,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...admitted, isPresenter: true }).position,
    ).toBe(true);
  });

  it("asks for an answer only once the Secretaría published the amendment", () => {
    const kept = { ...admitted, publishedAt: null, isPresenter: true };
    expect(amendmentCapabilities(kept).position).toBe(false);
    expect(
      amendmentCapabilities({ ...kept, rule: "incorporate" }).position,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...kept, isPresenter: false, moderate: true })
        .position,
    ).toBe(false);
  });

  it("leaves only publishing once the document is voted", () => {
    const incorporated = {
      ...admitted,
      status: "approved" as const,
      approvalMethod: "proponent" as const,
      isPresenter: true,
      rule: "incorporate" as const,
      voted: true,
    };
    expect(amendmentCapabilities(incorporated).position).toBe(false);
    expect(
      amendmentCapabilities({
        ...input,
        status: "submitted",
        isAuthor: true,
        review: true,
        acceptances: [{ memberId: "m1", decision: "pending" as const }],
        voted: true,
      }),
    ).toMatchObject({
      withdraw: false,
      accept: false,
      validate: false,
      position: false,
    });
    expect(
      amendmentCapabilities({ ...input, isAuthor: true, voted: true }),
    ).toMatchObject({ edit: false, submit: false });
    expect(
      amendmentCapabilities({
        ...input,
        status: "approved",
        review: true,
        validatedAt: at,
        voted: true,
      }).publish,
    ).toBe(true);
  });

  it("lets the main presenter change an answer that incorporated the amendment", () => {
    const incorporated = {
      ...admitted,
      status: "approved" as const,
      approvalMethod: "proponent" as const,
      isPresenter: true,
    };
    expect(
      amendmentCapabilities({ ...incorporated, rule: "incorporate" }).position,
    ).toBe(true);
    expect(amendmentCapabilities(incorporated).position).toBe(false);
  });

  it("offers acceptance only to a pending party of a presented transactional", () => {
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
    expect(amendmentCapabilities({ ...input, acceptances }).accept).toBe(false);
  });

  it("stops asking once what the transactional groups is no longer open", () => {
    const acceptances = [{ memberId: "m1", decision: "pending" as const }];
    const pending = { ...input, status: "submitted" as const, acceptances };
    expect(
      amendmentCapabilities({ ...pending, sourcesOpen: true }).accept,
    ).toBe(true);
    expect(
      amendmentCapabilities({ ...pending, sourcesOpen: false }).accept,
    ).toBe(false);
  });

  it("lets reviewers validate a transactional only once its main authors accepted it", () => {
    const transactional = {
      ...input,
      status: "submitted" as const,
      review: true,
    };
    expect(
      amendmentCapabilities({ ...transactional, authorsApproval: "pending" })
        .validate,
    ).toBe(false);
    expect(
      amendmentCapabilities({ ...transactional, authorsApproval: "accepted" })
        .validate,
    ).toBe(true);
  });

  it("does not ask for the main presenter's answer before the main authors accept", () => {
    expect(
      amendmentCapabilities({
        ...admitted,
        isPresenter: true,
        authorsApproval: "pending",
      }).position,
    ).toBe(false);
    expect(
      amendmentCapabilities({
        ...admitted,
        isPresenter: true,
        authorsApproval: "accepted",
      }).position,
    ).toBe(true);
  });

  it("passes the moderation and review flags through", () => {
    const caps = amendmentCapabilities({
      ...admitted,
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

describe("collectApprovalWarnings", () => {
  const a1 = { id: "a1", ops: [replace("b1", 0, 6, "Inicial")] };
  const a2 = { id: "a2", ops: [replace("b2", 0, 7, "Segundo")] };
  const approved = [
    a1,
    a2,
    // Outside the vote: a3 collides with a1, a4 with a2.
    { id: "a3", ops: [replace("b1", 2, 10, "otra cosa")] },
    { id: "a4", ops: [replace("b2", 1, 5, "algo")] },
    // In the vote too, and colliding with a1: left out.
    { id: "a5", ops: [replace("b1", 0, 3, "Ini")] },
  ];

  it("merges every approved amendment's warnings, outside the vote", () => {
    expect(
      collectApprovalWarnings({
        targets: [a1, a2],
        approved,
        links: [
          { fromId: "a1", toId: "a6" },
          // Seen from the other end, and again for the other target.
          { fromId: "a6", toId: "a2" },
          { fromId: "a7", toId: "a1" },
          // Linked to one of the vote: left out.
          { fromId: "a2", toId: "a5" },
          // Not live any more.
          { fromId: "a1", toId: "a8" },
          // Of neither target.
          { fromId: "a9", toId: "a10" },
        ],
        live: new Set(["a5", "a6", "a7", "a10"]),
        voted: new Set(["a1", "a2", "a5"]),
      }),
    ).toEqual({
      overlapsWithApproved: ["a3", "a4"],
      incompatible: ["a6", "a7"],
    });
  });

  it("answers null when the vote approved none", () => {
    expect(
      collectApprovalWarnings({
        targets: [],
        approved,
        links: [],
        live: new Set(),
        voted: new Set(["a1"]),
      }),
    ).toBeNull();
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

  it("falls back to the default majority it is given (a reform, RRI art. 65.5)", () => {
    // 6 of 13 valid votes: more in favor than against, but not over half.
    const counts = {
      method: "show_of_hands" as const,
      inFavor: 6,
      against: 4,
      abstentions: 3,
    };
    const reform = evaluateVoteInput(
      counts,
      settings,
      amendmentVoteMajority("statutes"),
    );
    expect(reform.majority).toBe("absolute");
    expect(reform.outcome.result).toBe("rejected");
    expect(
      evaluateVoteInput(counts, settings, amendmentVoteMajority("resolution"))
        .outcome.result,
    ).toBe("approved");
  });
});

describe("amendmentVoteMajority", () => {
  it("is absolute for the Estatutos and regulations, simple elsewhere", () => {
    expect(amendmentVoteMajority("regulation")).toBe("absolute");
    expect(amendmentVoteMajority("statutes")).toBe("absolute");
    expect(amendmentVoteMajority("resolution")).toBe("simple");
    expect(amendmentVoteMajority("positioning")).toBe("simple");
  });

  it("goes with incorporating what the presenter accepts", () => {
    for (const kind of REGULATION_DOCUMENT_KINDS) {
      expect(DOCUMENT_KIND_DEFAULTS[kind].acceptedAmendments).toBe(
        "incorporate",
      );
    }
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

describe("acceptanceRecordedBy", () => {
  it("is the Mesa's when the latest answer names the party it was for", () => {
    expect(acceptanceRecordedBy("ugr")).toBe("mesa");
  });

  it("is the party's own otherwise, also with no recorded answer", () => {
    expect(acceptanceRecordedBy(null)).toBe("party");
    expect(acceptanceRecordedBy(undefined)).toBe("party");
    expect(acceptanceRecordedBy("")).toBe("party");
  });
});

describe("toPositionDto", () => {
  const stored = {
    position: "accept" as const,
    comment: null,
    decidedByUserId: "user",
    updatedAt: new Date("2026-11-18T10:00:00Z"),
  } as unknown as Parameters<typeof toPositionDto>[0];
  const recorders = (memberId: string | null, mask?: Set<string>) => ({
    recordedAs: new Map([["a", "proponent"]]),
    memberOf: new Map([["user", memberId]]),
    answeredFor: new Map([["a", memberId]]),
    mask: mask ?? null,
  });

  it("names the co-presenter who answered", () => {
    const dto = toPositionDto(stored, "a", "main", recorders("co"), true);
    expect(dto).toMatchObject({ recordedBy: "presenter", answeredBy: "co" });
  });

  it("reads an office the reader does not see as the generic CEA", () => {
    const dto = toPositionDto(
      stored,
      "a",
      "main",
      recorders("office", new Set(["office"])),
      true,
    );
    expect(dto.answeredBy).toBe(GENERIC_EXECUTIVE_MEMBER_ID);
  });

  it("names nobody to a reader who may not know who answered", () => {
    expect(
      toPositionDto(stored, "a", "main", recorders("co"), false).answeredBy,
    ).toBeNull();
  });
});

describe("transactional sources", () => {
  it("groups the sources of each transactional", () => {
    const sourceMap = buildSourceMap([
      { transactionalId: "t1", sourceId: "a" },
      { transactionalId: "t1", sourceId: "b" },
      { transactionalId: "t2", sourceId: "t1" },
    ]);
    expect(sourceMap.get("t1")).toEqual(["a", "b"]);
    expect(sourceMap.get("t2")).toEqual(["t1"]);
    expect(sourceMap.get("a")).toBeUndefined();
  });

  describe("sourcesToReplace", () => {
    const at = new Date("2026-03-10T12:00:00Z");
    const open = (id: string) => ({
      id,
      status: "submitted" as const,
      admission: "admitted" as const,
      validatedAt: at,
      decidedAt: null,
    });

    it("replaces sources that are still open", () => {
      expect(sourcesToReplace([open("a"), open("b")])).toEqual({
        ids: ["a", "b"],
      });
    });

    it("refuses when one is decided or waits for the Secretaría", () => {
      expect(
        sourcesToReplace([open("a"), { ...open("b"), status: "approved" }]),
      ).toHaveProperty("message");
      expect(
        sourcesToReplace([
          { ...open("a"), admission: "pending", validatedAt: null },
        ]),
      ).toHaveProperty("message");
    });

    it("leaves a late source awaiting the assembly linked, not replaced", () => {
      const late = { ...open("late"), admission: "pending" as const };
      expect(sourcesToReplace([open("a"), late])).toEqual({ ids: ["a"] });
      expect(sourcesToReplace([late])).toEqual({ ids: [] });
      expect(sourcesAreOpen([open("a"), late])).toBe(true);
    });

    it("refuses a source already replaced, unless approving under the earlier rule", () => {
      const transacted = { ...open("b"), status: "transacted" as const };
      expect(sourcesToReplace([open("a"), transacted])).toHaveProperty(
        "message",
      );
      expect(sourcesToReplace([open("a"), transacted], true)).toEqual({
        ids: ["a"],
      });
    });

    it("tells whether every source is still open", () => {
      expect(sourcesAreOpen([open("a"), open("b")])).toBe(true);
      expect(sourcesAreOpen([])).toBe(true);
      expect(
        sourcesAreOpen([open("a"), { ...open("b"), status: "transacted" }]),
      ).toBe(false);
      expect(
        sourcesAreOpen([{ ...open("a"), status: "approved", decidedAt: at }]),
      ).toBe(false);
    });
  });

  describe("competing transactionals", () => {
    const sourceMap = buildSourceMap([
      { transactionalId: "t1", sourceId: "a" },
      { transactionalId: "t1", sourceId: "b" },
      { transactionalId: "t2", sourceId: "b" },
      { transactionalId: "t2", sourceId: "c" },
      { transactionalId: "t3", sourceId: "d" },
    ]);

    it("finds the other transactionals over the same amendments", () => {
      expect(competingTransactionalIds(sourceMap, "t1", ["a", "b"])).toEqual([
        "t2",
      ]);
      expect(competingTransactionalIds(sourceMap, "t3", ["d"])).toEqual([]);
      // A new one, not stored yet, competes with every one over its sources.
      expect(competingTransactionalIds(sourceMap, null, ["c", "d"])).toEqual([
        "t2",
        "t3",
      ]);
      expect(competingTransactionalIds(sourceMap, "t1", [])).toEqual([]);
    });

    it("spots a validation batch with two transactionals over the same amendment", () => {
      expect(transactionalsShareSources(sourceMap, ["t1", "t2"])).toBe(true);
      expect(transactionalsShareSources(sourceMap, ["t1", "t3", "x"])).toBe(
        false,
      );
      expect(transactionalsShareSources(sourceMap, ["t1", "t1"])).toBe(false);
    });
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

  it("always lets an executive area through, party or not", () => {
    expect(
      unauthorizedTransactionalAuthors(["me", "area", "stranger"], {
        ...input,
        executiveIds: new Set(["area"]),
      }),
    ).toEqual(["stranger"]);
  });
});

describe("composerAuthorsAccess", () => {
  const access = (
    input: Partial<Parameters<typeof composerAuthorsAccess>[0]> = {},
  ) =>
    composerAuthorsAccess({
      isAuthor: true,
      status: "draft",
      ...input,
    });

  it("answers an author of a draft", () => {
    expect(access()).toBe("ok");
  });

  it("refuses anyone who is not an author, whatever else holds", () => {
    expect(access({ isAuthor: false })).toBe("not_author");
    expect(access({ isAuthor: false, status: "submitted" })).toBe("not_author");
  });

  it("answers only while the amendment is a draft", () => {
    for (const status of [
      "submitted",
      "approved",
      "rejected",
      "withdrawn",
      "lapsed",
      "transacted",
      "inadmissible",
    ] as const) {
      expect(access({ status })).toBe("not_draft");
    }
  });
});

describe("visibility", () => {
  const { canSeeAmendment, canSeeDocument, presentsTransactionalDocument } =
    visibility;
  type Actor = Parameters<typeof canSeeAmendment>[0];
  type AmendmentInput = Parameters<typeof canSeeAmendment>[1];
  type DocumentInput = Parameters<typeof canSeeDocument>[1];
  type Role = "member" | "moderator" | "reviewer" | "manager";

  const actor = (role: Role, memberId: string | null = "m1") =>
    ({
      user: { id: `user-${role}` },
      memberId,
      role,
      can: () => false,
    }) as unknown as Actor;
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
      kind: "partial",
      status,
      publishedAt: null,
      validatedAt: null,
      documentPresenters: {
        proponentMemberId: "presenter",
        coProponentMemberIds: ["co-presenter"],
      },
      createdByUserId: "user-author",
      authorMemberIds: ["author"],
      partyMemberIds: [],
      ...extra,
    });
    const validatedAt = new Date("2026-03-09T12:00:00Z");
    /** A CEA account acting for an office that neither wrote nor presents. */
    const cea = {
      user: { id: "user-cea", role: { name: "CEA" } },
      memberId: "office",
      role: "cea",
      can: () => false,
    } as unknown as Actor;
    /** Someone given the control sheet by hand, outside the CEA. */
    const sheetReader = {
      user: { id: "user-sheet", role: { name: "Asociado" } },
      memberId: "council",
      role: "member",
      can: (key: string) => key === "control_sheet:view",
    } as unknown as Actor;

    it("shows a validated, unpublished amendment to the CEA, not to the document's other presenters", () => {
      for (const status of ["submitted", "approved"] as const) {
        const validated = amendment(status, { validatedAt });
        expect(canSeeAmendment(cea, validated)).toBe(true);
        // A presenter that is not the CEA waits for its publication.
        expect(canSeeAmendment(actor("member", "presenter"), validated)).toBe(
          false,
        );
        expect(
          canSeeAmendment(actor("member", "co-presenter"), validated),
        ).toBe(false);
        // So does whoever reads the control sheet, which lists them.
        expect(canSeeAmendment(sheetReader, validated)).toBe(true);
        // Anyone else still waits for its publication.
        expect(canSeeAmendment(actor("member"), validated)).toBe(false);
        expect(canSeeAmendment(actor("member", null), validated)).toBe(false);
      }
    });

    it("never makes a withdrawn amendment public, published or not", () => {
      for (const extra of [{}, { validatedAt }, { validatedAt, publishedAt }]) {
        const withdrawn = amendment("withdrawn", extra);
        // Its insiders, the CEA, the sheet's readers and the staff read it.
        expect(canSeeAmendment(actor("member", "author"), withdrawn)).toBe(
          true,
        );
        expect(canSeeAmendment(cea, withdrawn)).toBe(true);
        expect(canSeeAmendment(sheetReader, withdrawn)).toBe(true);
        for (const role of ["moderator", "reviewer", "manager"] as const) {
          expect(canSeeAmendment(actor(role), withdrawn)).toBe(true);
        }
        // Nobody else, not even the document's presenters.
        expect(canSeeAmendment(actor("member"), withdrawn)).toBe(false);
        expect(canSeeAmendment(actor("member", "presenter"), withdrawn)).toBe(
          false,
        );
      }
    });

    it("shows an amendment waiting for validation to the CEA, not to the document's presenters", () => {
      const waiting = amendment("submitted");
      // The whole CEA reads it from the moment it is presented.
      expect(canSeeAmendment(cea, waiting)).toBe(true);
      expect(canSeeAmendment(sheetReader, waiting)).toBe(false);
      expect(canSeeAmendment(actor("member", "presenter"), waiting)).toBe(
        false,
      );
      expect(canSeeAmendment(actor("member", "co-presenter"), waiting)).toBe(
        false,
      );
    });

    it("shows a presented transactional to the document's presenters before its publication", () => {
      // User's decision of 2026-11-21: from the moment it is presented.
      for (const extra of [{}, { validatedAt }]) {
        const transactional = amendment("submitted", {
          kind: "transactional",
          ...extra,
        });
        expect(
          canSeeAmendment(actor("member", "presenter"), transactional),
        ).toBe(true);
        expect(
          canSeeAmendment(actor("member", "co-presenter"), transactional),
        ).toBe(true);
        // Nobody else gains anything.
        expect(canSeeAmendment(actor("member"), transactional)).toBe(false);
        expect(canSeeAmendment(sheetReader, transactional)).toBe(
          extra.validatedAt !== undefined,
        );
      }
      // Never a draft or a withdrawn one, nor any other kind.
      for (const status of ["draft", "withdrawn"] as const) {
        expect(
          canSeeAmendment(
            actor("member", "presenter"),
            amendment(status, { kind: "transactional" }),
          ),
        ).toBe(false);
      }
      expect(
        canSeeAmendment(
          actor("member", "presenter"),
          amendment("submitted", { kind: "formal" }),
        ),
      ).toBe(false);
    });

    it("tells a transactional's presenters apart from its insiders", () => {
      const transactional = {
        kind: "transactional" as const,
        status: "submitted" as const,
        documentPresenters: {
          proponentMemberId: "presenter",
          coProponentMemberIds: ["co-presenter"],
        },
      };
      expect(
        presentsTransactionalDocument(
          actor("member", "co-presenter"),
          transactional,
        ),
      ).toBe(true);
      expect(
        presentsTransactionalDocument(actor("member", "author"), transactional),
      ).toBe(false);
      expect(
        presentsTransactionalDocument(actor("member", "presenter"), {
          ...transactional,
          kind: "partial",
        }),
      ).toBe(false);
    });

    it("keeps drafts from the CEA and the document's presenters, validated before or not", () => {
      const draft = amendment("draft", { validatedAt });
      expect(canSeeAmendment(cea, draft)).toBe(false);
      expect(canSeeAmendment(actor("member", "presenter"), draft)).toBe(false);
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

  describe("redactDocumentChanges", () => {
    const { redactDocumentChanges } = visibility;
    const payload = {
      fields: ["title"],
      changes: { title: { from: "Borrador interno", to: "Presupuesto" } },
    };

    it("keeps a document edit's values for those who saw the draft", () => {
      expect(redactDocumentChanges("document_updated", payload, true)).toBe(
        payload,
      );
    });

    it("drops them for everyone else, keeping which fields changed", () => {
      expect(redactDocumentChanges("document_updated", payload, false)).toEqual(
        { fields: ["title"] },
      );
      expect(redactDocumentChanges("assembly_updated", payload, false)).toBe(
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
      coProponentMemberIds: ["co"],
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

    it("shows drafts to co-presenters like to the main presenter", () => {
      expect(canSeeDocument(actor("member", "co"), document("draft"))).toBe(
        true,
      );
      expect(canSeeDocument(actor("member", "other"), document("draft"))).toBe(
        false,
      );
    });
  });
});

describe("inclusions in a transactional (2026-11-19)", () => {
  it("lets its main author, the Mesa and the Secretaría propose one", () => {
    const who = (over: Partial<Parameters<typeof canReviseTransactional>[0]>) =>
      canReviseTransactional({
        moderate: false,
        review: false,
        actsForMainAuthor: false,
        ...over,
      });
    expect(who({})).toBe(false);
    expect(who({ actsForMainAuthor: true })).toBe(true);
    expect(who({ moderate: true })).toBe(true);
    expect(who({ review: true })).toBe(true);
  });

  it("waits, falls back, applies or goes to the Secretaría", () => {
    expect(revisionAfterAnswers(["accepted", "pending"], false)).toBe("wait");
    expect(revisionAfterAnswers(["accepted", "rejected"], true)).toBe(
      "rejected",
    );
    expect(revisionAfterAnswers(["accepted", "accepted"], true)).toBe("apply");
    expect(revisionAfterAnswers(["accepted"], false)).toBe("validation");
    expect(revisionAfterAnswers([], false)).toBe("validation");
  });
});

/** A transaction whose selects answer `rows` and updates answer `updated`. */
function fakeTx(rows: unknown[], updated: unknown[] = []) {
  const chain = (result: unknown[]) => {
    const node: Record<string, unknown> = {};
    for (const key of ["from", "where", "set"]) node[key] = () => node;
    node.returning = async () => result;
    node.then = (resolve: (value: unknown) => void) => resolve(result);
    return node;
  };
  return {
    select: () => chain(rows),
    update: () => chain(updated),
  } as never;
}

describe("decisions under the assembly's lock (CON-4)", () => {
  const shareLock = vi.mocked(documentsModule.shareLockAssembly);
  const open = () =>
    shareLock.mockResolvedValueOnce({ status: "in_session" } as never);

  it("refuses a session suspended or closed since the request was read", async () => {
    open();
    await expect(lockOpenSession(fakeTx([]), "asm")).resolves.toBeUndefined();
    for (const status of ["convened", "closed"]) {
      shareLock.mockResolvedValueOnce({ status } as never);
      await expect(lockOpenSession(fakeTx([]), "asm")).rejects.toMatchObject({
        statusCode: 409,
      });
    }
  });

  it("checks the session before the split of a vote between alternatives", async () => {
    shareLock.mockResolvedValueOnce({ status: "convened" } as never);
    await expect(
      assertAlternativesUnderLock(fakeTx([]), {
        assemblyId: "asm",
        documentId: "doc",
        options: [["e3"], ["e4"]],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { messageKey: "common.errors.sessionNotOpen" },
    });
  });

  it("refuses a split other than the one on screen for its document", async () => {
    const input = {
      assemblyId: "asm",
      documentId: "doc",
      options: [["e3", "e5"], ["e4"]],
    };
    open();
    await expect(
      assertAlternativesUnderLock(
        fakeTx([{ documentId: "doc", options: [["e3"], ["e4", "e5"]] }]),
        input,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { messageKey: "session.alternatives.errors.splitChanged" },
    });
    // The same split, another document on screen, or no live state: it goes.
    for (const rows of [
      [{ documentId: "doc", options: [["e5", "e3"], ["e4"]] }],
      [{ documentId: "other", options: [["e3"], ["e4", "e5"]] }],
      [{ documentId: "doc", options: null }],
      [],
    ]) {
      open();
      await expect(
        assertAlternativesUnderLock(fakeTx(rows), input),
      ).resolves.toBeUndefined();
    }
  });

  it("refuses withdrawing or lapsing once the session is no longer open", async () => {
    vi.mocked(actorHelpers.canRecordResults).mockReturnValue(true);
    const transaction = vi.fn(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(fakeTx([])),
    );
    Object.assign(stubDb, { transaction });
    const ctx = {
      actor: {},
      now: new Date(),
      assembly: { id: "asm", status: "in_session" },
      document: { id: "doc", finalVoteId: null, consolidatedVersionId: null },
      amendment: {
        id: "e3",
        code: "E3",
        kind: "amendment",
        status: "submitted",
        admission: "admitted",
        sources: [],
      },
    } as never;
    for (const action of ["withdraw", "lapse"] as const) {
      shareLock.mockResolvedValueOnce({ status: "convened" } as never);
      await expect(
        applyAmendmentOutcome(ctx, {
          action,
          updatedAt: "2026-11-20T10:00:00.000Z",
        } as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        data: { messageKey: "common.errors.sessionNotOpen" },
      });
    }
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});

describe("an undecided vote between alternatives sent twice (VOT-2)", () => {
  it("moves the token on, and answers 409 when it already moved", async () => {
    await expect(
      touchVotedWithoutEffect(
        fakeTx([], [{ id: "e3" }]),
        "e3",
        "2026-11-20T10:00:00.000Z",
        { code: "E3" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      touchVotedWithoutEffect(
        fakeTx([], []),
        "e3",
        "2026-11-20T10:00:00.000Z",
        {
          code: "E3",
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "E3 ha cambiado. Recarga la página",
    });
  });
});

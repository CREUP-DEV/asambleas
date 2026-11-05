import { describe, expect, it } from "vitest";
import type {
  AcceptanceDto,
  AmendmentDto,
  MemberRef,
} from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  proponentReviewBacklog,
  transactionalAfterSecretaria,
  transactionalComposerSeed,
  transactionalGroupSources,
  transactionalMemberList,
  transactionalNextSteps,
  transactionalPresenterParty,
  transactionalProgressMessage,
  transactionalProgressOf,
  type TransactionalProgressView,
  transactionalSameBlocks,
  transactionalSameIds,
  transactionalSourceBlockers,
  transactionalSourceCandidates,
  transactionalSourceEligible,
  transactionalSourceLimit,
  transactionalSourcesInOrder,
} from "./transactional";

const p = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});

const base: Block[] = [
  p("b1", "Primer párrafo del texto."),
  p("b2", "El Consejo financiará la totalidad de las becas."),
  p("b3", "Tercer párrafo con más contenido."),
  p("b4", "Cuarto párrafo final."),
];

let counter = 0;
const newId = () => `new${(counter += 1).toString().padStart(4, "0")}`;

const member = (id: string): MemberRef => ({
  id,
  acronym: id.toUpperCase(),
  name: `Consejo ${id}`,
  kind: "asociado",
});

const party = (
  id: string,
  role: AcceptanceDto["role"],
  decision: AcceptanceDto["decision"] = "pending",
): AcceptanceDto => ({
  member: member(id),
  role,
  decision,
  decidedAt: decision === "pending" ? null : "2026-11-02T10:00:00.000Z",
});

function amendment(
  id: string,
  ops: AmendmentOp[],
  extra: Partial<AmendmentDto> = {},
): AmendmentDto {
  return {
    id,
    documentId: "doc",
    number: null,
    code: null,
    kind: "partial",
    status: "submitted",
    admission: "admitted",
    late: false,
    ops,
    globalReplace: null,
    justification: "",
    positionKey: 0,
    changeKinds: [],
    authors: [],
    submittedAt: null,
    validatedAt: null,
    publishedAt: null,
    reviewState: "published",
    correctionNote: null,
    decidedAt: null,
    approvalMethod: null,
    outcomeNote: null,
    outcomeVote: null,
    position: null,
    sourceIds: [],
    transactionalIds: [],
    acceptances: [],
    updatedAt: "2026-11-01T10:00:00.000Z",
    can: {
      edit: false,
      submit: false,
      withdraw: false,
      accept: false,
      position: false,
      moderate: false,
      review: false,
      validate: false,
      publish: false,
    },
    ...extra,
  };
}

const replace = (
  blockId: string,
  from: number,
  to: number,
  text: string,
): AmendmentOp => {
  const block = base.find((candidate) => candidate.id === blockId)!;
  return {
    op: "replace",
    blockId,
    from,
    to,
    text,
    baseText: block.text.slice(from, to),
  };
};

describe("transactional sources", () => {
  const change = [replace("b2", 3, 10, "Comité")];

  it("combines only published, admitted, undecided amendments with text", () => {
    expect(transactionalSourceEligible(amendment("a", change))).toBe(true);
    // Recorded before validation existed: public.
    expect(
      transactionalSourceEligible(
        amendment("a", change, { reviewState: null }),
      ),
    ).toBe(true);
    const no = (extra: Partial<AmendmentDto>, ops = change) =>
      transactionalSourceEligible(amendment("a", ops, extra));
    expect(no({ status: "draft", reviewState: null })).toBe(false);
    expect(no({ reviewState: "pending_validation" })).toBe(false);
    expect(no({ reviewState: "validated" })).toBe(false);
    expect(no({ reviewState: "pending_proponent" })).toBe(false);
    // Late and still waiting for the assembly's decision.
    expect(no({ late: true, admission: "pending" })).toBe(false);
    expect(no({ status: "approved", decidedAt: "2026-11-02" })).toBe(false);
    expect(no({ status: "withdrawn" })).toBe(false);
    expect(no({ status: "transacted" })).toBe(false);
    // A "devolución" has no passage to start from.
    expect(no({ kind: "totality_return" }, [])).toBe(false);
  });

  it("lists candidates in text order and picks them from a group", () => {
    const late = amendment("late", change, {
      positionKey: 1,
      late: true,
      admission: "pending",
    });
    const second = amendment("second", change, { positionKey: 3 });
    const first = amendment("first", change, { positionKey: 2 });
    const decided = amendment("decided", change, {
      status: "rejected",
      decidedAt: "2026-11-02",
    });
    expect(
      transactionalSourceCandidates([second, late, decided, first]).map(
        (item) => item.id,
      ),
    ).toEqual(["first", "second"]);
    expect(transactionalGroupSources([late, first, decided, second])).toEqual([
      "first",
      "second",
    ]);
  });

  it("orders sources by presentation for the starting text", () => {
    const list = [
      { id: "c", number: null, positionKey: 1 },
      { id: "b", number: 7, positionKey: 5 },
      { id: "a", number: 3, positionKey: 9 },
      { id: "d", number: 7, positionKey: 2 },
    ];
    expect(transactionalSourcesInOrder(list).map((item) => item.id)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("flags chosen sources that can no longer be combined", () => {
    const byId = new Map(
      [
        amendment("open", change),
        amendment("gone", change, {
          status: "approved",
          decidedAt: "2026-11-02",
        }),
      ].map((item) => [item.id, item]),
    );
    expect(
      transactionalSourceBlockers(["open", "gone", "missing"], byId),
    ).toEqual(["gone", "missing"]);
  });

  it("stops adding sources at the server's limit", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
    expect(transactionalSourceLimit(ids(2), 3)).toEqual({
      max: 3,
      full: false,
      over: false,
    });
    // Full: the remaining choices are disabled, but it can still be sent.
    expect(transactionalSourceLimit(ids(3), 3)).toMatchObject({
      full: true,
      over: false,
    });
    // Over: reached without the list (a group, a link); it cannot be sent.
    expect(transactionalSourceLimit(ids(4), 3)).toMatchObject({
      full: true,
      over: true,
    });
    // Repeats count once.
    expect(transactionalSourceLimit(["a", "a", "b"], 2).over).toBe(false);
    // The default is the API's MAX_TRANSACTIONAL_SOURCES (20).
    expect(transactionalSourceLimit(ids(20))).toMatchObject({
      max: 20,
      full: true,
      over: false,
    });
    expect(transactionalSourceLimit(ids(21)).over).toBe(true);
  });

  it("compares id sets and block contents", () => {
    expect(transactionalSameIds(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(transactionalSameIds(["a"], ["a", "b"])).toBe(false);
    expect(transactionalSameBlocks([p("x", "Hola")], [p("y", "Hola")])).toBe(
      true,
    );
    expect(transactionalSameBlocks([p("x", "Hola")], [p("x", "Adiós")])).toBe(
      false,
    );
  });
});

describe("transactional seed", () => {
  it("starts from the passage with the sources applied in order", () => {
    const first = amendment("first", [replace("b2", 3, 10, "Comité")]);
    const second = amendment("second", [replace("b3", 0, 6, "Último")]);
    const seed = transactionalComposerSeed(
      base,
      [first, second].map(({ id, ops }) => ({ id, ops })),
      newId,
    );
    expect(seed.passage.map((block) => block.id)).toEqual(["b2", "b3"]);
    expect(seed.anchorBefore).toBe("b1");
    expect(seed.seed.map((block) => block.text)).toEqual([
      "El Comité financiará la totalidad de las becas.",
      "Último párrafo con más contenido.",
    ]);
    expect(seed.skipped).toEqual([]);
    // Editing nothing more yields the combined change, valid over the base.
    const ops = diffPassage(seed.passage, seed.seed, seed.anchorBefore, newId);
    expect(ops.length).toBeGreaterThan(0);
    expect(validateOps(base, ops)).toEqual([]);
  });

  it("keeps the first source when two collide and reports the other", () => {
    const first = amendment("first", [replace("b2", 3, 10, "Comité")]);
    const clash = amendment("clash", [replace("b2", 3, 10, "Pleno")]);
    const seed = transactionalComposerSeed(
      base,
      [first, clash].map(({ id, ops }) => ({ id, ops })),
      newId,
    );
    expect(seed.seed.map((block) => block.text)).toEqual([
      "El Comité financiará la totalidad de las becas.",
    ]);
    expect(seed.skipped).toEqual(["clash"]);
  });

  it("gives inserted blocks fresh ids and handles an empty choice", () => {
    const insert = amendment("insert", [
      { op: "insert", afterBlockId: "b4", blocks: [p("own", "Nuevo final.")] },
    ]);
    const seed = transactionalComposerSeed(
      base,
      [{ id: insert.id, ops: insert.ops }],
      newId,
    );
    expect(seed.passage.map((block) => block.id)).toEqual(["b4"]);
    expect(seed.seed.map((block) => block.text)).toEqual([
      "Cuarto párrafo final.",
      "Nuevo final.",
    ]);
    expect(seed.seed[1]!.id).not.toBe("own");
    expect(transactionalComposerSeed(base, [], newId)).toEqual({
      passage: [],
      anchorBefore: null,
      seed: [],
      skipped: [],
    });
  });
});

describe("transactional progress", () => {
  const transactional = (extra: Partial<AmendmentDto>) =>
    amendment("t", [replace("b2", 3, 10, "Comité")], {
      kind: "transactional",
      code: "T1",
      ...extra,
    });

  it("says nothing for drafts, decided ones and ordinary amendments", () => {
    expect(
      transactionalProgressOf(
        transactional({ status: "draft", reviewState: null }),
        null,
      ),
    ).toBeNull();
    expect(
      transactionalProgressOf(transactional({ status: "approved" }), null),
    ).toBeNull();
    expect(transactionalProgressOf(amendment("a", []), null)).toBeNull();
  });

  it("waits first for the presenter, who sees it is their turn", () => {
    const pending = transactional({
      reviewState: "pending_proponent",
      acceptances: [party("ceum", "author"), party("cea", "proponent")],
    });
    expect(transactionalProgressOf(pending, null)).toMatchObject({
      stage: "proponent",
      proponent: { id: "cea" },
      actorTurn: false,
    });
    expect(transactionalProgressOf(pending, "cea")?.actorTurn).toBe(true);
    // An author waiting does not have to answer yet.
    expect(transactionalProgressOf(pending, "ceum")?.actorTurn).toBe(false);
    expect(
      transactionalProgressOf(
        transactional({
          reviewState: "pending_proponent",
          acceptances: [party("cea", "proponent", "rejected")],
        }),
        null,
      )?.stage,
    ).toBe("proponent_rejected");
  });

  it("finds the presenter by member, also when it wrote a source", () => {
    const parties = [party("ceum", "author"), party("cea", "author")];
    expect(transactionalPresenterParty(parties, "cea")?.member.id).toBe("cea");
    // Without the presenter's member, the role is the only hint.
    expect(transactionalPresenterParty(parties, null)).toBeNull();
    expect(
      transactionalPresenterParty(
        [party("ceum", "author"), party("cea", "proponent")],
        null,
      )?.member.id,
    ).toBe("cea");
    expect(
      transactionalPresenterParty([party("ceum", "author")], "cea"),
    ).toBeNull();
  });

  it("waits for a presenter that also wrote a source", () => {
    // The presenter proposed T1; T2 builds on it, so the presenter's single
    // row has the role "author" (buildAcceptanceParties).
    const pending = transactional({
      reviewState: "pending_proponent",
      acceptances: [
        party("ceum", "author", "accepted"),
        party("cea", "author"),
      ],
    });
    expect(transactionalProgressOf(pending, null, "cea")).toMatchObject({
      stage: "proponent",
      proponent: { id: "cea" },
      actorTurn: false,
    });
    expect(transactionalProgressOf(pending, "cea", "cea")?.actorTurn).toBe(
      true,
    );
    expect(transactionalProgressOf(pending, "ceum", "cea")?.actorTurn).toBe(
      false,
    );
    expect(
      transactionalProgressOf(
        transactional({
          reviewState: "pending_proponent",
          acceptances: [
            party("ceum", "author", "accepted"),
            party("cea", "author", "rejected"),
          ],
        }),
        null,
        "cea",
      ),
    ).toMatchObject({ stage: "proponent_rejected", proponent: { id: "cea" } });
  });

  it("then waits for the Secretaría to check and publish it", () => {
    expect(
      transactionalProgressOf(
        transactional({ reviewState: "pending_validation" }),
        null,
      )?.stage,
    ).toBe("validation");
    expect(
      transactionalProgressOf(transactional({ reviewState: "validated" }), null)
        ?.stage,
    ).toBe("publication");
  });

  it("then lists who still has to accept it, and who said no", () => {
    const waiting = transactionalProgressOf(
      transactional({
        acceptances: [
          party("ceum", "author", "accepted"),
          party("ceuca", "author"),
          party("ceune", "author"),
          party("cea", "proponent", "accepted"),
        ],
      }),
      "ceune",
    );
    expect(waiting).toMatchObject({ stage: "parties", actorTurn: true });
    expect(transactionalMemberList(waiting!.missing)).toBe("CEUCA, CEUNE");

    const refused = transactionalProgressOf(
      transactional({
        acceptances: [
          party("ceum", "author", "rejected"),
          party("ceuca", "author"),
        ],
      }),
      null,
    );
    expect(refused?.stage).toBe("rejected");
    expect(transactionalMemberList(refused!.rejected)).toBe("CEUM");
  });

  it("is ready once everyone accepted and it is admitted", () => {
    const accepted = [
      party("ceum", "author", "accepted"),
      party("cea", "proponent", "accepted"),
    ];
    expect(
      transactionalProgressOf(transactional({ acceptances: accepted }), null),
    ).toMatchObject({ stage: "ready", color: "success", missing: [] });
    expect(
      transactionalProgressOf(
        transactional({ acceptances: accepted, admission: "pending" }),
        null,
      )?.stage,
    ).toBe("admission");
  });
});

describe("transactional progress sentences", () => {
  const view = (
    extra: Partial<TransactionalProgressView>,
  ): TransactionalProgressView => ({
    stage: "parties",
    color: "warning",
    icon: "i-lucide-users",
    proponent: member("cea"),
    missing: [],
    rejected: [],
    actorTurn: false,
    ...extra,
  });
  const message = (
    extra: Partial<TransactionalProgressView>,
    form: "short" | "long",
  ) => transactionalProgressMessage(view(extra), form);

  it("names the presenter, or tells the presenter it is their turn", () => {
    expect(message({ stage: "proponent" }, "short")).toEqual({
      key: "transactional.progress.short.proponent",
      params: { member: "CEA" },
    });
    expect(message({ stage: "proponent", actorTurn: true }, "long")).toEqual({
      key: "transactional.progress.long.yourApproval",
      params: {},
    });
    expect(message({ stage: "proponent", proponent: null }, "long")?.key).toBe(
      "transactional.progress.long.proponentUnknown",
    );
    expect(message({ stage: "proponent_rejected" }, "short")).toEqual({
      key: "transactional.progress.short.proponent_rejected",
      params: { member: "CEA" },
    });
  });

  it("leaves the detail to the Secretaría's sentence while it has it", () => {
    for (const stage of ["validation", "publication"] as const) {
      expect(message({ stage }, "long")).toBeNull();
      expect(message({ stage }, "short")?.key).toBe(
        `transactional.progress.short.${stage}`,
      );
    }
    // Then who will still have to accept it, only if someone has to.
    expect(
      transactionalAfterSecretaria(
        view({ stage: "validation", missing: [member("ceum")] }),
      ),
    ).toEqual({
      key: "transactional.progress.afterSecretaria",
      params: { members: "CEUM" },
    });
    expect(
      transactionalAfterSecretaria(view({ stage: "publication" })),
    ).toBeNull();
    expect(
      transactionalAfterSecretaria(
        view({ stage: "parties", missing: [member("ceum")] }),
      ),
    ).toBeNull();
  });

  it("lists who is missing, and tells a missing party it is their turn", () => {
    const missing = [member("ceum"), member("ceuca")];
    expect(message({ missing }, "short")).toEqual({
      key: "transactional.progress.short.parties",
      params: { members: "CEUM, CEUCA" },
    });
    expect(message({ missing, actorTurn: true }, "short")).toEqual({
      key: "transactional.progress.short.yourAcceptance",
      params: {},
    });
    expect(message({ missing, actorTurn: true }, "long")).toEqual({
      key: "transactional.progress.long.yourAcceptance",
      params: { members: "CEUM, CEUCA" },
    });
  });

  it("names those who said no, not those still missing", () => {
    expect(
      message(
        {
          stage: "rejected",
          rejected: [member("ceune")],
          missing: [member("ceum")],
        },
        "long",
      ),
    ).toEqual({
      key: "transactional.progress.long.rejected",
      params: { members: "CEUNE" },
    });
    expect(message({ stage: "ready" }, "long")?.key).toBe(
      "transactional.progress.long.ready",
    );
    expect(message({ stage: "admission" }, "short")?.key).toBe(
      "transactional.progress.short.admission",
    );
  });
});

describe("after sending a transactional", () => {
  it("goes to the presenter, the Secretaría and the authors", () => {
    const steps = transactionalNextSteps({
      reviewState: "pending_proponent",
      acceptances: [
        party("prop", "author", "accepted"),
        party("ceum", "author"),
        party("cea", "proponent"),
      ],
    });
    expect(steps.map((step) => step.key)).toEqual([
      "proponent",
      "secretaria",
      "parties",
      "vote",
    ]);
    expect(steps[0]!.members.map((item) => item.id)).toEqual(["cea"]);
    expect(steps[2]!.members.map((item) => item.id)).toEqual(["ceum"]);
  });

  it("names a presenter that also wrote a source once, in its own step", () => {
    const steps = transactionalNextSteps(
      {
        reviewState: "pending_proponent",
        acceptances: [
          party("prop", "author", "accepted"),
          party("ceum", "author"),
          party("cea", "author"),
        ],
      },
      "cea",
    );
    expect(steps.map((step) => step.key)).toEqual([
      "proponent",
      "secretaria",
      "parties",
      "vote",
    ]);
    expect(steps[0]!.members.map((item) => item.id)).toEqual(["cea"]);
    expect(steps[2]!.members.map((item) => item.id)).toEqual(["ceum"]);
  });

  it("skips the presenter when it proposed the transactional itself", () => {
    expect(
      transactionalNextSteps({
        reviewState: "pending_validation",
        acceptances: [party("cea", "proponent", "accepted")],
      }).map((step) => step.key),
    ).toEqual(["secretaria", "vote"]);
  });

  it("is public at once when the Mesa proposes it", () => {
    const steps = transactionalNextSteps({
      reviewState: "published",
      acceptances: [party("ceum", "author"), party("cea", "proponent")],
    });
    expect(steps.map((step) => step.key)).toEqual(["parties", "vote"]);
    expect(steps[0]!.members.map((item) => item.id)).toEqual(["ceum", "cea"]);
  });
});

describe("the presenter's review", () => {
  const can = { ...amendment("x", []).can, position: true };

  it("counts positions to take and transactionals to approve", () => {
    const list = [
      amendment("open", [], { can }),
      amendment("pendingPosition", [], {
        can,
        position: {
          position: "pending",
          comment: null,
          updatedAt: "2026-11-01",
        },
      }),
      amendment("answered", [], {
        can,
        position: {
          position: "accept",
          comment: null,
          updatedAt: "2026-11-01",
        },
      }),
      amendment("unchecked", [], { can, reviewState: "pending_validation" }),
      amendment("decided", [], { can, status: "approved" }),
      amendment("hidden", []),
      amendment("toApprove", [], {
        kind: "transactional",
        reviewState: "pending_proponent",
        acceptances: [party("cea", "proponent")],
      }),
      amendment("approved", [], {
        kind: "transactional",
        acceptances: [party("cea", "proponent", "accepted")],
      }),
    ];
    expect(proponentReviewBacklog(list)).toEqual({
      positions: 2,
      transactionals: 1,
      total: 3,
    });
    expect(proponentReviewBacklog(list, "cea")).toEqual({
      positions: 2,
      transactionals: 1,
      total: 3,
    });
  });

  it("counts a transactional whose presenter also wrote a source", () => {
    const list = [
      amendment("toApprove", [], {
        kind: "transactional",
        reviewState: "pending_proponent",
        acceptances: [
          party("ceum", "author", "accepted"),
          party("cea", "author"),
        ],
      }),
      amendment("approved", [], {
        kind: "transactional",
        reviewState: "pending_validation",
        acceptances: [
          party("ceum", "author"),
          party("cea", "author", "accepted"),
        ],
      }),
    ];
    // "approved" waits for CEUM, an author, not for the presenter.
    expect(proponentReviewBacklog(list, "cea")).toEqual({
      positions: 0,
      transactionals: 1,
      total: 1,
    });
    // Without the presenter's member, an "author" row is not the presenter.
    expect(proponentReviewBacklog(list).transactionals).toBe(0);
  });
});

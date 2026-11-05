import { describe, expect, it } from "vitest";
import type { AcceptanceDto, AmendmentDto } from "~~/shared/types/api";
import {
  acceptanceTarget,
  awaitsProponentApproval,
  commentUnsaved,
  fallbackStep,
  firstPendingId,
  initialStep,
  isPositionAnswered,
  isPositionReviewable,
  positionCounts,
  proponentReviewItems,
  proponentReviewProgress,
  recordedPositionCounts,
  reviewSequence,
  stepAfter,
  stepBefore,
  stepCounter,
  transactionalAnswerCounts,
} from "./-review";

const CEA = {
  id: "cea",
  acronym: "CEA-AC",
  name: "Área",
  kind: "executive",
} as const;
const CEUM = {
  id: "ceum",
  acronym: "CEUM",
  name: "CEUM",
  kind: "asociado",
} as const;

type Overrides = Partial<Omit<AmendmentDto, "can">> & {
  can?: Partial<AmendmentDto["can"]>;
};

function amendment(id: string, overrides: Overrides = {}): AmendmentDto {
  const { can, ...rest } = overrides;
  return {
    id,
    documentId: "doc",
    number: 1,
    code: `CEUM ${id}`,
    kind: "partial",
    status: "submitted",
    admission: "admitted",
    late: false,
    ops: [],
    globalReplace: null,
    justification: "",
    positionKey: 0,
    changeKinds: [],
    authors: [CEUM],
    submittedAt: "2026-11-01T10:00:00.000Z",
    validatedAt: "2026-11-01T11:00:00.000Z",
    publishedAt: "2026-11-01T11:00:00.000Z",
    reviewState: "published",
    correctionNote: null,
    decidedAt: null,
    approvalMethod: null,
    outcomeNote: null,
    outcomeVote: null,
    position: { position: "pending", comment: null, updatedAt: "" },
    sourceIds: [],
    transactionalIds: [],
    acceptances: [],
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...rest,
    can: {
      edit: false,
      submit: false,
      withdraw: false,
      accept: false,
      position: true,
      moderate: false,
      review: false,
      validate: false,
      publish: false,
      ...can,
    },
  };
}

function party(
  member: AcceptanceDto["member"],
  role: AcceptanceDto["role"],
  decision: AcceptanceDto["decision"] = "pending",
): AcceptanceDto {
  return { member, role, decision, decidedAt: null };
}

function transactional(id: string, overrides: Overrides = {}): AmendmentDto {
  return amendment(id, {
    kind: "transactional",
    code: `T${id}`,
    reviewState: "pending_proponent",
    validatedAt: null,
    publishedAt: null,
    acceptances: [party(CEUM, "author", "accepted"), party(CEA, "proponent")],
    ...overrides,
  });
}

function answered(position: "accept" | "reject" | "transact") {
  return { position, comment: null, updatedAt: "2026-11-02T10:00:00.000Z" };
}

describe("positions", () => {
  it("counts a null or pending position as not answered", () => {
    expect(isPositionAnswered(amendment("a", { position: null }))).toBe(false);
    expect(isPositionAnswered(amendment("a"))).toBe(false);
    expect(
      isPositionAnswered(amendment("a", { position: answered("reject") })),
    ).toBe(true);
  });

  it("answers presented, published and undecided amendments only", () => {
    expect(isPositionReviewable(amendment("a"))).toBe(true);
    // Validated but kept private: the presenter cannot read it, so the
    // Mesa does not answer it for the presenter either.
    expect(
      isPositionReviewable(
        amendment("a", {
          reviewState: "validated",
          publishedAt: null,
          can: { position: true, moderate: true },
        }),
      ),
    ).toBe(false);
    expect(
      isPositionReviewable(
        amendment("a", { reviewState: "pending_validation" }),
      ),
    ).toBe(false);
    expect(isPositionReviewable(amendment("a", { status: "approved" }))).toBe(
      false,
    );
    expect(
      isPositionReviewable(amendment("a", { can: { position: false } })),
    ).toBe(false);
    expect(isPositionReviewable(transactional("t"))).toBe(false);
  });
});

describe("transactionals", () => {
  it("waits for the presenter while its approval is pending", () => {
    expect(awaitsProponentApproval(transactional("1"), "cea")).toBe(true);
    // Created by the Mesa in session: public, presenter still to answer.
    expect(
      awaitsProponentApproval(
        transactional("1", { reviewState: "published" }),
        "cea",
      ),
    ).toBe(true);
    expect(
      awaitsProponentApproval(
        transactional("1", {
          reviewState: "pending_validation",
          acceptances: [party(CEA, "proponent", "accepted")],
        }),
        "cea",
      ),
    ).toBe(false);
    // A draft never presented is not the presenter's business yet.
    expect(
      awaitsProponentApproval(
        transactional("1", { status: "draft", reviewState: null }),
        "cea",
      ),
    ).toBe(false);
    expect(
      awaitsProponentApproval(
        transactional("1", { status: "withdrawn" }),
        "cea",
      ),
    ).toBe(false);
  });

  it("finds the presenter by member when it also wrote a source", () => {
    // CEA-AC presents the document and wrote one of the sources: the
    // server keeps a single row for it, with the role "author".
    const both = transactional("1", {
      acceptances: [party(CEUM, "author", "accepted"), party(CEA, "author")],
      can: { accept: true },
    });
    expect(awaitsProponentApproval(both, "cea")).toBe(true);
    expect(acceptanceTarget(both, "cea", "cea")).toEqual({
      party: party(CEA, "author"),
      memberId: null,
    });
    expect(
      acceptanceTarget(
        { ...both, can: { ...both.can, accept: false, moderate: true } },
        "mesa",
        "cea",
      )?.memberId,
    ).toBe("cea");
    expect(
      proponentReviewItems([both], "cea", "cea").map((item) => item.kind),
    ).toEqual(["transactional"]);
  });

  it("does not take another party's row for the presenter's", () => {
    const decided = transactional("1", {
      acceptances: [party(CEUM, "author"), party(CEA, "proponent", "accepted")],
      can: { moderate: true },
    });
    expect(awaitsProponentApproval(decided, "cea")).toBe(false);
    expect(acceptanceTarget(decided, "mesa", "cea")).toBeNull();
    // The presenter is not a party: nothing to approve.
    expect(awaitsProponentApproval(decided, "other")).toBe(false);
    // Unknown presenter: the role "proponent" is the fallback.
    expect(acceptanceTarget(decided, "mesa", null)).toBeNull();
    expect(awaitsProponentApproval(transactional("2"), null)).toBe(true);
  });

  it("lets the presenter answer for itself", () => {
    const target = acceptanceTarget(
      transactional("1", { can: { accept: true } }),
      "cea",
      "cea",
    );
    expect(target?.memberId).toBeNull();
    expect(target?.party.member.id).toBe("cea");
  });

  it("lets the Mesa record the presenter's answer", () => {
    const target = acceptanceTarget(
      transactional("1", { can: { moderate: true } }),
      "other",
      "cea",
    );
    expect(target?.memberId).toBe("cea");
  });

  it("offers nothing to anyone else", () => {
    expect(acceptanceTarget(transactional("1"), "ceum", "cea")).toBeNull();
    expect(acceptanceTarget(transactional("1"), null, "cea")).toBeNull();
    expect(
      acceptanceTarget(
        transactional("1", {
          acceptances: [party(CEA, "proponent", "accepted")],
          can: { accept: true, moderate: true },
        }),
        "cea",
        "cea",
      ),
    ).toBeNull();
  });
});

describe("transactionalAnswerCounts", () => {
  it("counts the presenter's answers on record", () => {
    expect(
      transactionalAnswerCounts(
        [
          transactional("1", {
            acceptances: [party(CEA, "proponent", "accepted")],
          }),
          // The presenter's row has the role "author" here.
          transactional("2", {
            status: "approved",
            acceptances: [party(CEA, "author", "rejected")],
          }),
          transactional("3"),
          // Proposed by the presenter itself: accepted on creation.
          transactional("4", {
            authors: [CEA],
            acceptances: [party(CEA, "proponent", "accepted")],
          }),
          transactional("5", {
            status: "draft",
            acceptances: [party(CEA, "proponent", "accepted")],
          }),
          amendment("a", { position: answered("accept") }),
        ],
        "cea",
      ),
    ).toEqual({ approved: 1, rejected: 1 });
  });
});

describe("commentUnsaved", () => {
  it("compares the trimmed draft with the saved comment", () => {
    expect(commentUnsaved(undefined, "Bien")).toBe(false);
    expect(commentUnsaved("Bien ", "Bien")).toBe(false);
    expect(commentUnsaved("", null)).toBe(false);
    expect(commentUnsaved("Mejor así", null)).toBe(true);
    expect(commentUnsaved("", "Bien")).toBe(true);
  });
});

describe("proponentReviewItems", () => {
  const list = [
    amendment("late", { positionKey: 30 }),
    amendment("first", { positionKey: 10, position: answered("accept") }),
    transactional("2", {
      positionKey: 20,
      can: { accept: true },
    }),
    amendment("hidden", { positionKey: 5, reviewState: "pending_validation" }),
    amendment("private", { positionKey: 6, reviewState: "validated" }),
    transactional("3", { positionKey: 1 }),
  ];

  it("puts the transactionals the actor approves first, then text order", () => {
    const items = proponentReviewItems(list, "cea", "cea");
    expect(items.map((item) => [item.id, item.kind, item.answered])).toEqual([
      ["2", "transactional", false],
      ["first", "position", true],
      ["late", "position", false],
    ]);
  });

  it("counts the progress over the amendments to answer", () => {
    const items = proponentReviewItems(list, "cea", "cea");
    expect(proponentReviewProgress(items)).toEqual({
      answered: 1,
      total: 2,
      transactionals: 1,
    });
    expect(positionCounts(items)).toEqual({
      pending: 1,
      accept: 1,
      reject: 0,
      transact: 0,
    });
  });

  it("numbers each step among the steps of its kind", () => {
    const items = proponentReviewItems(list, "cea", "cea");
    expect(stepCounter(items, "2")).toEqual({
      kind: "transactional",
      current: 1,
      total: 1,
    });
    expect(stepCounter(items, "late")).toEqual({
      kind: "position",
      current: 2,
      total: 2,
    });
    expect(stepCounter(items, "hidden")).toBeNull();
    expect(stepCounter(items, null)).toBeNull();
  });
});

describe("recordedPositionCounts", () => {
  it("counts the answers on record, decided or not", () => {
    expect(
      recordedPositionCounts([
        amendment("a", { status: "approved", position: answered("accept") }),
        amendment("b", { status: "rejected", position: answered("reject") }),
        amendment("c", { position: answered("reject") }),
        amendment("d", { status: "draft", position: answered("accept") }),
        amendment("e", { position: null }),
        transactional("t", { position: answered("accept") }),
      ]),
    ).toEqual({ pending: 0, accept: 1, reject: 2, transact: 0 });
  });
});

describe("cursor", () => {
  const items = proponentReviewItems(
    [
      amendment("a", { positionKey: 1, position: answered("accept") }),
      amendment("b", { positionKey: 2 }),
      amendment("c", { positionKey: 3, position: answered("reject") }),
      amendment("d", { positionKey: 4 }),
    ],
    "cea",
    "cea",
  );

  it("hides answered steps on request, except the one on screen", () => {
    expect(
      reviewSequence(items, { onlyPending: true, pinnedId: null }).map(
        (item) => item.id,
      ),
    ).toEqual(["b", "d"]);
    expect(
      reviewSequence(items, { onlyPending: true, pinnedId: "c" }).map(
        (item) => item.id,
      ),
    ).toEqual(["b", "c", "d"]);
    expect(
      reviewSequence(items, { onlyPending: false, pinnedId: null }),
    ).toHaveLength(4);
  });

  it("moves forward and back", () => {
    const sequence = reviewSequence(items, {
      onlyPending: false,
      pinnedId: null,
    });
    expect(stepAfter(sequence, "a")).toBe("b");
    expect(stepAfter(sequence, "d")).toBeNull();
    expect(stepBefore(sequence, "b")).toBe("a");
    expect(stepBefore(sequence, "a")).toBeNull();
    expect(stepAfter(sequence, "gone")).toBeNull();
  });

  it("falls back to the step that took the place of one that left", () => {
    const sequence = reviewSequence(items, {
      onlyPending: true,
      pinnedId: null,
    });
    expect(fallbackStep(sequence, 1)).toBe("d");
    expect(fallbackStep(sequence, 7)).toBe("d");
    expect(fallbackStep([], 0)).toBeNull();
  });

  it("opens on the linked amendment or the first pending one", () => {
    expect(firstPendingId(items)).toBe("b");
    expect(initialStep(items, "c")).toBe("c");
    expect(initialStep(items, "unknown")).toBe("b");
    expect(
      initialStep(
        items.filter((item) => item.answered),
        null,
      ),
    ).toBeNull();
  });
});

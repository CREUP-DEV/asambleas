import { describe, expect, it } from "vitest";
import type {
  AmendmentDto,
  AmendmentReviewState,
  DocumentSummaryDto,
  ReviewQueueAmendmentDto,
  ReviewQueueDto,
} from "~~/shared/types/api";
import {
  applyAmendmentResults,
  canRecordAdmission,
  canSelectSeveral,
  groupReviewAmendments,
  isSelectionFull,
  isAwaitingAssembly,
  isAwaitingAuthors,
  isAwaitingPublication,
  isInReviewQueue,
  missingAuthors,
  pendingReviewCount,
  removeReviewAmendments,
  removeReviewDocument,
  reviewGroupSize,
  reviewQueueKey,
  selectAllReviewIds,
  selectableReviewIds,
  shareSources,
  splitReviewSelection,
  withoutSharedSources,
  blockedBySelection,
} from "./-queue";

function amendment(
  id: string,
  reviewState: AmendmentReviewState | null,
  overrides: Partial<AmendmentDto> = {},
): AmendmentDto {
  return {
    id,
    documentId: "doc",
    number: null,
    code: null,
    kind: "partial",
    status: reviewState === "correction_requested" ? "draft" : "submitted",
    admission: "pending",
    late: false,
    ops: [],
    globalReplace: null,
    justification: "",
    positionKey: 0,
    changeKinds: [],
    authors: [],
    mainAuthorId: null,
    submittedAt: null,
    validatedAt: null,
    publishedAt: null,
    reviewState,
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
      review: true,
      validate: reviewState === "pending_validation",
      publish: reviewState === "validated",
    },
    ...overrides,
  };
}

/** A transactional its authors accepted, waiting for validation. */
function transactional(id: string, sourceIds: string[]): AmendmentDto {
  return amendment(id, "pending_validation", {
    kind: "transactional",
    sourceIds,
  });
}

/** A late amendment the Secretaría validated, waiting for the assembly. */
function late(
  id: string,
  reviewState: "published" | "validated" = "published",
  overrides: Partial<AmendmentDto> = {},
): AmendmentDto {
  return amendment(id, reviewState, {
    late: true,
    validatedAt: "2026-11-02T10:00:00.000Z",
    publishedAt:
      reviewState === "published" ? "2026-11-02T10:00:00.000Z" : null,
    ...overrides,
  });
}

const member = {
  id: "m1",
  acronym: "VPU",
  name: "Vicepresidencia",
  kind: "executive" as const,
};
const other = { ...member, id: "m2", acronym: "CEUM", name: "CEUM" };
const third = { ...member, id: "m3", acronym: "CEUCA", name: "CEUCA" };

/** A member's transactional that one main author rejected. */
function rejectedTransactional(
  id: string,
  reviewState: "pending_authors" | null,
): AmendmentDto {
  return amendment(id, reviewState, {
    kind: "transactional",
    status: reviewState === null ? "rejected" : "submitted",
    acceptances: [
      { member, role: "author", decision: "accepted", decidedAt: null },
      {
        member: other,
        role: "author",
        decision: "rejected",
        decidedAt: "2026-11-02T10:00:00.000Z",
      },
    ],
  });
}

const docA = { id: "a", slug: "res-a", title: "A", reference: "RES 1/2026" };
const docB = { id: "b", slug: "res-b", title: "B", reference: null };

function entry(
  document: ReviewQueueAmendmentDto["document"],
  value: AmendmentDto,
): ReviewQueueAmendmentDto {
  return { document, amendment: value };
}

function queue(
  amendments: ReviewQueueAmendmentDto[],
  documents: Pick<DocumentSummaryDto, "id">[] = [],
): ReviewQueueDto {
  return {
    documents: documents as DocumentSummaryDto[],
    amendments,
  };
}

describe("reviewQueueKey", () => {
  it("is scoped to the assembly", () => {
    expect(reviewQueueKey("x1")).toBe("assembly-review-x1");
  });
});

describe("isInReviewQueue", () => {
  it("keeps presented, validated and author-pending amendments", () => {
    expect(isInReviewQueue(amendment("1", "pending_validation"))).toBe(true);
    expect(isInReviewQueue(amendment("2", "validated"))).toBe(true);
    expect(isInReviewQueue(amendment("3", "pending_authors"))).toBe(true);
  });

  it("drops a transactional one of its authors rejected", () => {
    // Whether the server keeps "pending_authors" or clears the state.
    expect(
      isInReviewQueue(rejectedTransactional("t1", "pending_authors")),
    ).toBe(false);
    expect(isInReviewQueue(rejectedTransactional("t2", null))).toBe(false);
  });

  it("drops published, sent back and settled amendments on time", () => {
    expect(isInReviewQueue(amendment("1", "published"))).toBe(false);
    expect(isInReviewQueue(amendment("2", "correction_requested"))).toBe(false);
    expect(isInReviewQueue(amendment("3", null))).toBe(false);
  });

  it("keeps late ones waiting for the assembly, published or not", () => {
    expect(isInReviewQueue(late("1", "published"))).toBe(true);
    expect(isInReviewQueue(late("2", "validated"))).toBe(true);
  });

  it("drops late ones once the assembly decided", () => {
    expect(
      isInReviewQueue(late("1", "published", { admission: "admitted" })),
    ).toBe(false);
    expect(
      isInReviewQueue(
        late("2", "published", {
          admission: "inadmissible",
          status: "inadmissible",
        }),
      ),
    ).toBe(false);
  });
});

describe("isAwaitingAssembly", () => {
  it("needs a late, validated, submitted amendment pending admission", () => {
    expect(isAwaitingAssembly(late("1"))).toBe(true);
    expect(isAwaitingAssembly(late("2", "published", { late: false }))).toBe(
      false,
    );
    expect(
      isAwaitingAssembly(late("3", "published", { validatedAt: null })),
    ).toBe(false);
    expect(
      isAwaitingAssembly(late("4", "published", { status: "withdrawn" })),
    ).toBe(false);
  });

  it("takes a late validated private amendment out of the publication list", () => {
    expect(isAwaitingPublication(late("1", "validated"))).toBe(false);
    expect(isAwaitingPublication(amendment("2", "validated"))).toBe(true);
  });
});

describe("canRecordAdmission", () => {
  const can = amendment("x", "published").can;

  it("needs a late amendment waiting and a reviewer or the Mesa", () => {
    expect(canRecordAdmission(late("1"))).toBe(true);
    expect(
      canRecordAdmission(
        late("2", "published", {
          can: { ...can, review: false, moderate: true },
        }),
      ),
    ).toBe(true);
    expect(
      canRecordAdmission(
        late("3", "published", {
          can: { ...can, review: false, moderate: false },
        }),
      ),
    ).toBe(false);
    expect(canRecordAdmission(amendment("4", "published"))).toBe(false);
  });
});

describe("isAwaitingAuthors", () => {
  it("is a transactional no author has rejected yet", () => {
    expect(isAwaitingAuthors(amendment("t", "pending_authors"))).toBe(true);
    expect(isAwaitingAuthors(amendment("v", "pending_validation"))).toBe(false);
    expect(
      isAwaitingAuthors(rejectedTransactional("r", "pending_authors")),
    ).toBe(false);
  });
});

describe("missingAuthors", () => {
  it("lists who has not answered yet, once each, in the server's order", () => {
    const value = amendment("t", "pending_authors", {
      kind: "transactional",
      acceptances: [
        {
          member: other,
          role: "author",
          decision: "accepted",
          decidedAt: null,
        },
        { member, role: "author", decision: "pending", decidedAt: null },
        {
          member: third,
          role: "author",
          decision: "pending",
          decidedAt: null,
        },
        { member, role: "author", decision: "pending", decidedAt: null },
      ],
    });
    expect(missingAuthors(value).map((item) => item.acronym)).toEqual([
      "VPU",
      "CEUCA",
    ]);
  });

  it("is empty when everyone answered or there are no parties", () => {
    expect(missingAuthors(amendment("p", "pending_validation"))).toEqual([]);
    expect(missingAuthors(rejectedTransactional("r", null))).toEqual([]);
  });
});

describe("pendingReviewCount", () => {
  const value = queue(
    [
      entry(docA, amendment("1", "pending_validation")),
      entry(docA, amendment("2", "validated")),
      entry(docB, amendment("3", "pending_validation")),
    ],
    [{ id: "d1" }, { id: "d2" }],
  );

  it("counts documents and amendments waiting for validation", () => {
    expect(
      pendingReviewCount(value, { documents: true, amendments: true }),
    ).toBe(4);
  });

  it("leaves out validated amendments kept unpublished", () => {
    expect(
      pendingReviewCount(value, { documents: false, amendments: true }),
    ).toBe(2);
  });

  it("counts only what the actor can validate", () => {
    expect(
      pendingReviewCount(value, { documents: true, amendments: false }),
    ).toBe(2);
  });

  it("leaves out what waits for the authors or the assembly", () => {
    const waiting = queue([
      entry(docA, amendment("t", "pending_authors")),
      entry(docA, late("l")),
      entry(docA, amendment("v", "pending_validation")),
    ]);
    expect(
      pendingReviewCount(waiting, { documents: true, amendments: true }),
    ).toBe(1);
  });

  it("is zero without a queue", () => {
    expect(
      pendingReviewCount(null, { documents: true, amendments: true }),
    ).toBe(0);
  });
});

describe("groupReviewAmendments", () => {
  it("groups by document in order of appearance and splits by state", () => {
    const groups = groupReviewAmendments([
      entry(docB, amendment("b1", "pending_validation")),
      entry(docA, amendment("a2", "validated", { positionKey: 5 })),
      entry(docA, amendment("a1", "pending_validation", { positionKey: 9 })),
      entry(docA, amendment("a0", "pending_validation", { positionKey: 1 })),
    ]);
    expect(groups.map((group) => group.document.id)).toEqual(["b", "a"]);
    expect(groups[1]!.toValidate.map((value) => value.id)).toEqual([
      "a0",
      "a1",
    ]);
    expect(groups[1]!.toPublish.map((value) => value.id)).toEqual(["a2"]);
  });

  it("orders by number when the position is the same", () => {
    const groups = groupReviewAmendments([
      entry(docA, amendment("x", "pending_validation", { number: 4 })),
      entry(docA, amendment("y", "pending_validation", { number: 2 })),
    ]);
    expect(groups[0]!.toValidate.map((value) => value.id)).toEqual(["y", "x"]);
  });

  it("drops documents left with nothing to review", () => {
    expect(
      groupReviewAmendments([entry(docA, amendment("p", "published"))]),
    ).toEqual([]);
  });

  it("lists author-pending transactionals and late ones apart", () => {
    const groups = groupReviewAmendments([
      entry(docA, amendment("t", "pending_authors", { kind: "transactional" })),
      entry(docA, late("l2", "published", { positionKey: 8 })),
      entry(docA, late("l1", "validated", { positionKey: 2 })),
      entry(docA, amendment("v", "pending_validation")),
    ]);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.toValidate.map((value) => value.id)).toEqual(["v"]);
    expect(group.awaitingAuthors.map((value) => value.id)).toEqual(["t"]);
    expect(group.toPublish).toEqual([]);
    expect(group.late.map((value) => value.id)).toEqual(["l1", "l2"]);
    expect(reviewGroupSize(group)).toBe(2);
  });

  it("leaves out a transactional one of its authors rejected", () => {
    const groups = groupReviewAmendments([
      entry(docA, rejectedTransactional("r", "pending_authors")),
      entry(docB, rejectedTransactional("s", null)),
      entry(docB, amendment("v", "pending_validation")),
    ]);
    expect(groups.map((group) => group.document.id)).toEqual(["b"]);
    expect(groups[0]!.awaitingAuthors).toEqual([]);
    expect(groups[0]!.toValidate.map((value) => value.id)).toEqual(["v"]);
  });

  it("keeps a document whose only amendments are late", () => {
    const groups = groupReviewAmendments([entry(docB, late("l"))]);
    expect(groups.map((group) => group.document.id)).toEqual(["b"]);
    expect(reviewGroupSize(groups[0]!)).toBe(0);
  });
});

describe("splitReviewSelection", () => {
  const group = {
    toValidate: [
      amendment("v1", "pending_validation"),
      amendment("v2", "pending_validation", {
        can: { ...amendment("v2", "pending_validation").can, validate: false },
      }),
    ],
    toPublish: [amendment("p1", "validated")],
  };

  it("keeps only the selected amendments each action may apply to", () => {
    expect(
      splitReviewSelection(group, new Set(["v1", "v2", "p1", "other"])),
    ).toEqual({ validate: ["v1"], validateOnly: ["v1"], publish: ["p1"] });
  });

  it("never validates a transactional waiting for its authors", () => {
    const pending = amendment("t", "pending_authors", {
      can: { ...amendment("t", "pending_validation").can, validate: true },
    });
    expect(
      splitReviewSelection(
        { toValidate: [pending], toPublish: [] },
        new Set(["t"]),
      ),
    ).toEqual({ validate: [], validateOnly: [], publish: [] });
  });

  it("is empty without a selection", () => {
    expect(splitReviewSelection(group, new Set())).toEqual({
      validate: [],
      validateOnly: [],
      publish: [],
    });
  });

  it("never keeps a transactional private when validating", () => {
    const t1 = transactional("t1", ["a"]);
    expect(
      splitReviewSelection(
        {
          toValidate: [amendment("v1", "pending_validation"), t1],
          toPublish: [],
        },
        new Set(["v1", "t1"]),
      ),
    ).toEqual({ validate: ["v1", "t1"], validateOnly: ["v1"], publish: [] });
  });

  it("validates only the first of two transactionals that share an amendment", () => {
    const t1 = transactional("t1", ["a", "b"]);
    const t2 = transactional("t2", ["b", "c"]);
    const t3 = transactional("t3", ["d"]);
    expect(
      splitReviewSelection(
        { toValidate: [t1, t2, t3], toPublish: [] },
        new Set(["t1", "t2", "t3"]),
      ),
    ).toEqual({ validate: ["t1", "t3"], validateOnly: [], publish: [] });
  });
});

describe("shareSources", () => {
  it("is true for two transactionals that group the same amendment", () => {
    expect(
      shareSources(transactional("t1", ["a", "b"]), transactional("t2", ["b"])),
    ).toBe(true);
  });

  it("is false for disjoint ones, the same one or a plain amendment", () => {
    const t1 = transactional("t1", ["a"]);
    expect(shareSources(t1, transactional("t2", ["b"]))).toBe(false);
    expect(shareSources(t1, t1)).toBe(false);
    expect(
      shareSources(
        t1,
        amendment("p", "pending_validation", { sourceIds: ["a"] }),
      ),
    ).toBe(false);
  });
});

describe("withoutSharedSources", () => {
  it("keeps the first transactional over an amendment, in order", () => {
    const list = [
      transactional("t2", ["b", "c"]),
      amendment("v1", "pending_validation"),
      transactional("t1", ["a", "b"]),
      transactional("t3", ["c"]),
      transactional("t4", ["d"]),
    ];
    expect(withoutSharedSources(list).map((value) => value.id)).toEqual([
      "t2",
      "v1",
      "t4",
    ]);
  });
});

describe("blockedBySelection", () => {
  const t1 = transactional("t1", ["a", "b"]);
  const t2 = transactional("t2", ["b"]);
  const t3 = transactional("t3", ["c"]);
  const plain = amendment("v1", "pending_validation");

  it("blocks unselected transactionals that share with a selected one", () => {
    expect(
      blockedBySelection([plain, t1, t2, t3], new Set(["t2", "v1"])),
    ).toEqual(new Map([["t1", "t2"]]));
  });

  it("never blocks a selected one, so it can be unselected", () => {
    expect(blockedBySelection([t1, t2], new Set(["t1", "t2"]))).toEqual(
      new Map(),
    );
  });

  it("blocks nothing without a selection", () => {
    expect(blockedBySelection([t1, t2, t3], new Set())).toEqual(new Map());
  });
});

describe("selectableReviewIds and selectAllReviewIds", () => {
  const t1 = transactional("t1", ["a", "b"]);
  const t2 = transactional("t2", ["b"]);
  const cannot = amendment("v2", "pending_validation", {
    can: { ...amendment("v2", "pending_validation").can, validate: false },
  });
  const group = {
    toValidate: [amendment("v1", "pending_validation"), t1, t2, cannot],
    toPublish: [amendment("p1", "validated")],
  };

  it("lists everything the actor may validate or publish now", () => {
    expect(selectableReviewIds(group)).toEqual(["v1", "t1", "t2", "p1"]);
  });

  it("selects all but a transactional that shares with an earlier one", () => {
    expect(selectAllReviewIds(group)).toEqual(["v1", "t1", "p1"]);
  });

  it("keeps the transactional already chosen and adds what still fits", () => {
    expect(selectAllReviewIds(group, new Set(["t2"]))).toEqual([
      "v1",
      "t2",
      "p1",
    ]);
  });
});

describe("canSelectSeveral and isSelectionFull", () => {
  // T1 groups an amendment with T2 and another with T3; T2 and T3 share
  // nothing, so they can go together although "select all" picks only T1.
  const t1 = transactional("t1", ["a", "b"]);
  const t2 = transactional("t2", ["a"]);
  const t3 = transactional("t3", ["b"]);
  const triangle = { toValidate: [t1, t2, t3], toPublish: [] };

  it("offers checkboxes when some pair can be validated together", () => {
    expect(selectAllReviewIds(triangle)).toEqual(["t1"]);
    expect(canSelectSeveral(triangle)).toBe(true);
    expect(selectAllReviewIds(triangle, new Set(["t2"])).sort()).toEqual([
      "t2",
      "t3",
    ]);
  });

  it("offers none when every pair shares an amendment", () => {
    expect(
      canSelectSeveral({
        toValidate: [t1, transactional("t4", ["a", "b"])],
        toPublish: [],
      }),
    ).toBe(false);
    expect(canSelectSeveral({ toValidate: [t1], toPublish: [] })).toBe(false);
  });

  it("counts something to publish next to something to validate", () => {
    expect(
      canSelectSeveral({
        toValidate: [t1],
        toPublish: [amendment("p1", "validated")],
      }),
    ).toBe(true);
    expect(
      canSelectSeveral({
        toValidate: [],
        toPublish: [amendment("p1", "validated")],
      }),
    ).toBe(false);
  });

  it("is full once everything left is selected or kept out", () => {
    expect(isSelectionFull(triangle, new Set(["t1"]))).toBe(true);
    expect(isSelectionFull(triangle, new Set(["t2"]))).toBe(false);
    expect(isSelectionFull(triangle, new Set(["t2", "t3"]))).toBe(true);
    expect(isSelectionFull(triangle, new Set())).toBe(false);
  });
});

describe("applyAmendmentResults", () => {
  const before = queue([
    entry(docA, amendment("1", "pending_validation")),
    entry(docA, amendment("2", "pending_validation")),
    entry(docA, amendment("3", "pending_validation")),
    entry(docB, amendment("4", "validated")),
  ]);

  it("moves validated ones, drops published ones and keeps the rest", () => {
    const after = applyAmendmentResults(before, [
      amendment("1", "validated"),
      amendment("2", "published"),
      amendment("9", "published"),
    ]);
    expect(
      after.amendments.map((value) => [
        value.amendment.id,
        value.amendment.reviewState,
      ]),
    ).toEqual([
      ["1", "validated"],
      ["3", "pending_validation"],
      ["4", "validated"],
    ]);
    expect(after.amendments[0]!.document).toBe(docA);
  });

  it("keeps a late one the Secretaría validated and published", () => {
    const after = applyAmendmentResults(
      queue([
        entry(docA, amendment("1", "pending_validation", { late: true })),
      ]),
      [late("1", "published")],
    );
    expect(after.amendments.map((value) => value.amendment.id)).toEqual(["1"]);
  });

  it("drops a transactional once one of its authors rejects it", () => {
    const after = applyAmendmentResults(
      queue([
        entry(docA, amendment("t", "pending_authors")),
        entry(docA, amendment("u", "pending_authors")),
      ]),
      [rejectedTransactional("t", "pending_authors")],
    );
    expect(after.amendments.map((value) => value.amendment.id)).toEqual(["u"]);
  });

  it("does not mutate the queue it receives", () => {
    applyAmendmentResults(before, [amendment("1", "published")]);
    expect(before.amendments).toHaveLength(4);
  });
});

describe("removeReviewAmendments and removeReviewDocument", () => {
  it("removes the given amendments", () => {
    const value = queue([
      entry(docA, amendment("1", "pending_validation")),
      entry(docA, amendment("2", "pending_validation")),
    ]);
    expect(
      removeReviewAmendments(value, ["1"]).amendments.map(
        (item) => item.amendment.id,
      ),
    ).toEqual(["2"]);
  });

  it("removes the given document", () => {
    const value = queue([], [{ id: "d1" }, { id: "d2" }]);
    expect(
      removeReviewDocument(value, "d1").documents.map((item) => item.id),
    ).toEqual(["d2"]);
  });
});

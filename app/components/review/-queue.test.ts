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
  groupReviewAmendments,
  isInReviewQueue,
  pendingReviewCount,
  removeReviewAmendments,
  removeReviewDocument,
  reviewQueueKey,
  splitReviewSelection,
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
  it("keeps presented and validated amendments only", () => {
    expect(isInReviewQueue({ reviewState: "pending_validation" })).toBe(true);
    expect(isInReviewQueue({ reviewState: "validated" })).toBe(true);
    expect(isInReviewQueue({ reviewState: "published" })).toBe(false);
    expect(isInReviewQueue({ reviewState: "correction_requested" })).toBe(
      false,
    );
    expect(isInReviewQueue({ reviewState: null })).toBe(false);
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
    ).toEqual({ validate: ["v1"], publish: ["p1"] });
  });

  it("is empty without a selection", () => {
    expect(splitReviewSelection(group, new Set())).toEqual({
      validate: [],
      publish: [],
    });
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

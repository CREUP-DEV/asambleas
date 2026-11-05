import { describe, expect, it } from "vitest";
import {
  admissionNeedsValidation,
  agendaPositions,
  admissionOnValidation,
  amendmentReviewState,
  awaitsPublication,
  awaitsValidation,
  hasPendingReview,
  isAmendmentPublishable,
  isDocumentOverdue,
  numberingToKeep,
  submissionLate,
  unopenSourceReason,
  unopenSourcesMessage,
  UNOPEN_SOURCE_MESSAGES,
  type AmendmentReviewFields,
} from "./reviewState";

const at = new Date("2026-11-01T10:00:00Z");

function row(
  overrides: Partial<AmendmentReviewFields> = {},
): AmendmentReviewFields {
  return {
    status: "submitted",
    validatedAt: null,
    publishedAt: null,
    correctionRequestedAt: null,
    ...overrides,
  };
}

describe("amendmentReviewState", () => {
  it("has no state for a draft never presented", () => {
    expect(amendmentReviewState(row({ status: "draft" }))).toBeNull();
  });

  it("tells the authors a correction was requested", () => {
    expect(
      amendmentReviewState(row({ status: "draft", correctionRequestedAt: at })),
    ).toBe("correction_requested");
  });

  it("follows validation and publication", () => {
    expect(amendmentReviewState(row())).toBe("pending_validation");
    expect(amendmentReviewState(row({ validatedAt: at }))).toBe("validated");
    expect(
      amendmentReviewState(row({ validatedAt: at, publishedAt: at })),
    ).toBe("published");
    expect(
      amendmentReviewState(
        row({ status: "approved", validatedAt: at, publishedAt: at }),
      ),
    ).toBe("published");
  });
});

describe("amendmentReviewState of settled amendments", () => {
  it("has no state when it was settled before the Secretaría checked it", () => {
    for (const status of ["withdrawn", "lapsed", "inadmissible"] as const) {
      expect(amendmentReviewState(row({ status }))).toBeNull();
    }
  });

  it("does not ask to publish a withdrawn or inadmissible one", () => {
    for (const status of ["withdrawn", "inadmissible"] as const) {
      expect(amendmentReviewState(row({ status, validatedAt: at }))).toBeNull();
    }
    expect(
      amendmentReviewState(
        row({ status: "withdrawn", validatedAt: at, publishedAt: at }),
      ),
    ).toBe("published");
  });

  it("keeps a validated one still in the debate waiting for publication", () => {
    expect(
      amendmentReviewState(row({ status: "lapsed", validatedAt: at })),
    ).toBe("validated");
  });
});

describe("admissionNeedsValidation", () => {
  const onTime = { status: "submitted", late: false, validatedAt: null };

  it("keeps the Mesa from admitting an on-time amendment nobody validated", () => {
    expect(admissionNeedsValidation(onTime, "admitted", false)).toBe(true);
    expect(admissionNeedsValidation(onTime, "admitted", true)).toBe(true);
  });

  it("refuses a vote on it, since a failed inadmission vote admits it", () => {
    expect(admissionNeedsValidation(onTime, "inadmissible", true)).toBe(true);
    expect(admissionNeedsValidation(onTime, "inadmissible", false)).toBe(false);
  });

  it("lets the Mesa decide on late or validated amendments", () => {
    const late = { ...onTime, late: true };
    expect(admissionNeedsValidation(late, "admitted", true)).toBe(false);
    expect(
      admissionNeedsValidation(
        { ...onTime, validatedAt: at },
        "admitted",
        false,
      ),
    ).toBe(false);
  });

  it("lets an inadmissible amendment be admitted again", () => {
    expect(
      admissionNeedsValidation(
        { status: "inadmissible", late: false, validatedAt: null },
        "admitted",
        false,
      ),
    ).toBe(false);
  });
});

describe("transactional sources", () => {
  const source = (
    overrides: Partial<Parameters<typeof unopenSourceReason>[0]> = {},
  ) => ({
    status: "submitted" as const,
    admission: "admitted" as const,
    validatedAt: at,
    decidedAt: null,
    ...overrides,
  });

  it("explains why a source cannot be grouped", () => {
    expect(unopenSourceReason(source())).toBeNull();
    expect(
      unopenSourceReason(source({ admission: "pending", validatedAt: null })),
    ).toBe("not_validated");
    expect(unopenSourceReason(source({ admission: "pending" }))).toBe(
      "not_admitted",
    );
    expect(unopenSourceReason(source({ status: "approved" }))).toBe("decided");
    expect(unopenSourceReason(source({ decidedAt: at }))).toBe("decided");
  });

  it("says first what someone can still do", () => {
    expect(unopenSourcesMessage([source()])).toBeNull();
    expect(
      unopenSourcesMessage([
        source({ status: "approved" }),
        source({ admission: "pending", validatedAt: null }),
      ]),
    ).toBe(UNOPEN_SOURCE_MESSAGES.not_validated);
    expect(
      unopenSourcesMessage([
        source({ status: "withdrawn" }),
        source({ admission: "pending" }),
      ]),
    ).toBe(UNOPEN_SOURCE_MESSAGES.not_admitted);
  });
});

describe("awaitsValidation", () => {
  it("is only for presented amendments not validated yet", () => {
    expect(awaitsValidation(row())).toBe(true);
    expect(awaitsValidation(row({ validatedAt: at }))).toBe(false);
    expect(awaitsValidation(row({ status: "draft" }))).toBe(false);
    expect(awaitsValidation(row({ status: "withdrawn" }))).toBe(false);
  });
});

describe("publication", () => {
  it("lists validated amendments still relevant to the debate", () => {
    expect(awaitsPublication(row({ validatedAt: at }))).toBe(true);
    expect(
      awaitsPublication(row({ status: "approved", validatedAt: at })),
    ).toBe(true);
    expect(awaitsPublication(row())).toBe(false);
    expect(awaitsPublication(row({ validatedAt: at, publishedAt: at }))).toBe(
      false,
    );
  });

  it("does not nag about withdrawn or inadmissible ones, which can still be published", () => {
    for (const status of ["withdrawn", "inadmissible"] as const) {
      const settled = row({ status, validatedAt: at });
      expect(awaitsPublication(settled)).toBe(false);
      expect(isAmendmentPublishable(settled)).toBe(true);
    }
  });

  it("publishes only validated amendments past draft", () => {
    expect(isAmendmentPublishable(row())).toBe(false);
    expect(
      isAmendmentPublishable(row({ status: "draft", validatedAt: at })),
    ).toBe(false);
    expect(
      isAmendmentPublishable(row({ validatedAt: at, publishedAt: at })),
    ).toBe(false);
  });
});

describe("admissionOnValidation", () => {
  it("admits on-time amendments and leaves late ones to the Mesa", () => {
    expect(admissionOnValidation({ late: false, admission: "pending" })).toBe(
      "admitted",
    );
    expect(admissionOnValidation({ late: true, admission: "pending" })).toBe(
      "pending",
    );
  });
});

describe("submissionLate", () => {
  it("computes lateness on a first presentation", () => {
    expect(
      submissionLate({ late: false, correctionRequestedAt: null }, true),
    ).toBe(true);
    expect(
      submissionLate({ late: true, correctionRequestedAt: null }, false),
    ).toBe(false);
  });

  it("keeps the timing of the first presentation after a correction", () => {
    expect(
      submissionLate({ late: false, correctionRequestedAt: at }, true),
    ).toBe(false);
    expect(
      submissionLate({ late: true, correctionRequestedAt: at }, false),
    ).toBe(true);
  });
});

describe("numberingToKeep", () => {
  it("assigns everything on a first presentation", () => {
    expect(
      numberingToKeep({ number: null, memberSeq: null, code: null }, "CEUM"),
    ).toEqual({ number: null, memberSeq: null });
  });

  it("keeps number and code while the same member presents it", () => {
    expect(
      numberingToKeep({ number: 7, memberSeq: 2, code: "CEUM 2" }, "CEUM"),
    ).toEqual({ number: 7, memberSeq: 2 });
  });

  it("keeps the number but renumbers the code for another member", () => {
    expect(
      numberingToKeep({ number: 7, memberSeq: 2, code: "CEUM 2" }, "CAUB"),
    ).toEqual({ number: 7, memberSeq: null });
  });
});

describe("documents and counts", () => {
  const now = new Date("2026-11-05T10:00:00Z");

  it("flags expected drafts past their internal deadline", () => {
    const past = new Date("2026-11-04T10:00:00Z");
    const future = new Date("2026-11-06T10:00:00Z");
    expect(isDocumentOverdue({ status: "draft", dueAt: past }, now)).toBe(true);
    expect(isDocumentOverdue({ status: "draft", dueAt: future }, now)).toBe(
      false,
    );
    expect(isDocumentOverdue({ status: "draft", dueAt: null }, now)).toBe(
      false,
    );
    expect(isDocumentOverdue({ status: "submitted", dueAt: past }, now)).toBe(
      false,
    );
  });

  it("reports an assembly only when something is pending", () => {
    const none = {
      documentsToValidate: 0,
      amendmentsToValidate: 0,
      amendmentsToPublish: 0,
      documentsOverdue: 0,
    };
    expect(hasPendingReview(none)).toBe(false);
    expect(hasPendingReview({ ...none, documentsOverdue: 1 })).toBe(true);
  });
});

describe("agendaPositions", () => {
  it("orders roots by order, each followed by its sub-items", () => {
    const position = agendaPositions([
      { id: "b", parentId: null, order: 2 },
      { id: "a", parentId: null, order: 1 },
      { id: "a2", parentId: "a", order: 2 },
      { id: "a1", parentId: "a", order: 1 },
    ]);
    expect([...position.entries()].sort((x, y) => x[1] - y[1])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a2", 2],
      ["b", 3],
    ]);
  });

  it("puts items with a missing parent among the roots", () => {
    const position = agendaPositions([
      { id: "x", parentId: "gone", order: 0 },
      { id: "a", parentId: null, order: 1 },
    ]);
    expect(position.get("x")).toBe(0);
    expect(position.get("a")).toBe(1);
  });
});

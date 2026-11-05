import { describe, expect, it } from "vitest";
import {
  acceptedRulePlan,
  admissionNeedsValidation,
  agendaPositions,
  admissionOnValidation,
  amendmentReviewState,
  authorsApproval,
  awaitsAssemblyDecision,
  awaitsAuthors,
  awaitsPublication,
  awaitsValidation,
  countPositionsPending,
  hasPendingReview,
  isAmendmentPublishable,
  isDocumentOverdue,
  mainAuthorOf,
  numberingToKeep,
  pickMainAuthor,
  positionBlocker,
  positionEffect,
  replacesSources,
  submissionLate,
  transactionalReopenBlocker,
  transactionalSourceReason,
  transactionalSourcesMessage,
  unopenSourceReason,
  unopenSourcesMessage,
  TRANSACTIONAL_SOURCE_MESSAGES,
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

  it("waits for the main authors of a transactional", () => {
    expect(awaitsValidation(row({ authorsApproval: "pending" }))).toBe(false);
    expect(awaitsValidation(row({ authorsApproval: "rejected" }))).toBe(false);
    expect(awaitsValidation(row({ authorsApproval: "accepted" }))).toBe(true);
    expect(awaitsValidation(row({ authorsApproval: null }))).toBe(true);
  });
});

describe("transactionals and their main authors", () => {
  const party = (
    decision: "pending" | "accepted" | "rejected",
    role: "author" | "proponent" = "author",
  ) => ({ role, decision });

  it("waits until every main author accepted", () => {
    expect(
      authorsApproval({
        kind: "transactional",
        acceptances: [party("accepted"), party("pending")],
      }),
    ).toBe("pending");
    expect(
      authorsApproval({
        kind: "transactional",
        acceptances: [party("accepted"), party("accepted")],
      }),
    ).toBe("accepted");
  });

  it("is rejected as soon as one main author rejects it", () => {
    expect(
      authorsApproval({
        kind: "transactional",
        acceptances: [party("pending"), party("rejected")],
      }),
    ).toBe("rejected");
  });

  it("ignores the presenter rows of the earlier rule", () => {
    expect(
      authorsApproval({
        kind: "transactional",
        acceptances: [party("accepted"), party("pending", "proponent")],
      }),
    ).toBe("accepted");
  });

  it("needs nobody's answer without parties, and none for other kinds", () => {
    expect(authorsApproval({ kind: "transactional", acceptances: [] })).toBe(
      "accepted",
    );
    expect(
      authorsApproval({ kind: "partial", acceptances: [party("pending")] }),
    ).toBeNull();
  });

  it("waits for the main authors before the Secretaría", () => {
    expect(awaitsAuthors(row({ authorsApproval: "pending" }))).toBe(true);
    expect(amendmentReviewState(row({ authorsApproval: "pending" }))).toBe(
      "pending_authors",
    );
    expect(amendmentReviewState(row({ authorsApproval: "accepted" }))).toBe(
      "pending_validation",
    );
  });

  it("is past the gate once validated (the Mesa presents it validated)", () => {
    expect(
      awaitsAuthors(row({ validatedAt: at, authorsApproval: "pending" })),
    ).toBe(false);
    expect(
      amendmentReviewState(
        row({ validatedAt: at, publishedAt: at, authorsApproval: "pending" }),
      ),
    ).toBe("published");
  });

  it("waits for nothing once a rejection closed it", () => {
    expect(
      amendmentReviewState(
        row({ status: "withdrawn", authorsApproval: "rejected" }),
      ),
    ).toBeNull();
  });

  it("replaces its sources once validated and accepted, whichever comes last", () => {
    const transactional = {
      kind: "transactional" as const,
      status: "submitted" as const,
      validatedAt: at,
      authorsApproval: "accepted" as const,
    };
    expect(replacesSources(transactional)).toBe(true);
    expect(replacesSources({ ...transactional, validatedAt: null })).toBe(
      false,
    );
    expect(
      replacesSources({ ...transactional, authorsApproval: "pending" }),
    ).toBe(false);
    expect(replacesSources({ ...transactional, status: "withdrawn" })).toBe(
      false,
    );
    expect(
      replacesSources({
        ...transactional,
        kind: "partial",
        authorsApproval: null,
      }),
    ).toBe(false);
  });
});

describe("main author", () => {
  it("is the presenting member while it is still an author", () => {
    expect(mainAuthorOf(["a", "b"], "b")).toBe("b");
    expect(mainAuthorOf(["a"], "gone")).toBe("a");
    expect(mainAuthorOf(["c", "b"], undefined)).toBe("b");
    expect(mainAuthorOf([], "a")).toBeNull();
  });

  it("must be one of the authors when named", () => {
    expect(pickMainAuthor(["a", "b"], "b")).toBe("b");
    expect(pickMainAuthor(["a", "b"], "c")).toBe("not_author");
    expect(pickMainAuthor([], "c")).toBe("not_author");
  });

  it("is required with several authors, unless the stored one stays", () => {
    expect(pickMainAuthor(["a"], undefined)).toBe("a");
    expect(pickMainAuthor(["a", "b"], null)).toBe("required");
    expect(pickMainAuthor(["a", "b"], undefined, "a")).toBe("a");
    expect(pickMainAuthor(["a", "b"], undefined, "gone")).toBe("required");
    expect(pickMainAuthor([], undefined)).toBeNull();
  });
});

describe("awaitsAssemblyDecision", () => {
  const late = (
    overrides: Partial<Parameters<typeof awaitsAssemblyDecision>[0]> = {},
  ): Parameters<typeof awaitsAssemblyDecision>[0] => ({
    status: "submitted",
    late: true,
    admission: "pending",
    validatedAt: at,
    ...overrides,
  });

  it("waits for the assembly once validated, published or not", () => {
    expect(awaitsAssemblyDecision(late())).toBe(true);
  });

  it("does not wait before the Secretaría validates it", () => {
    expect(awaitsAssemblyDecision(late({ validatedAt: null }))).toBe(false);
  });

  it("does not wait once decided or when on time", () => {
    expect(awaitsAssemblyDecision(late({ admission: "admitted" }))).toBe(false);
    expect(
      awaitsAssemblyDecision(
        late({ status: "inadmissible", admission: "inadmissible" }),
      ),
    ).toBe(false);
    expect(awaitsAssemblyDecision(late({ status: "withdrawn" }))).toBe(false);
    expect(awaitsAssemblyDecision(late({ late: false }))).toBe(false);
  });
});

describe("sources of a new transactional", () => {
  const source = (
    overrides: Partial<Parameters<typeof transactionalSourceReason>[0]> = {},
  ) => ({
    status: "submitted" as const,
    admission: "admitted" as const,
    validatedAt: at,
    decidedAt: null,
    publishedAt: at,
    ...overrides,
  });

  it("must be published as well as open", () => {
    expect(transactionalSourceReason(source())).toBeNull();
    expect(transactionalSourceReason(source({ publishedAt: null }))).toBe(
      "not_published",
    );
    expect(
      transactionalSourceReason(
        source({ admission: "pending", validatedAt: null, publishedAt: null }),
      ),
    ).toBe("not_validated");
  });

  it("says first what someone can still do", () => {
    expect(transactionalSourcesMessage([source()])).toBeNull();
    expect(
      transactionalSourcesMessage([
        source({ status: "approved" }),
        source({ publishedAt: null }),
      ]),
    ).toBe(TRANSACTIONAL_SOURCE_MESSAGES.not_published);
    expect(
      transactionalSourcesMessage([
        source({ publishedAt: null }),
        source({ admission: "pending" }),
      ]),
    ).toBe(TRANSACTIONAL_SOURCE_MESSAGES.not_admitted);
    expect(transactionalSourcesMessage([source({ decidedAt: at })])).toBe(
      UNOPEN_SOURCE_MESSAGES.decided,
    );
  });

  it("refuses a transactional that has not replaced what it groups", () => {
    expect(
      transactionalSourceReason(source({ authorsApproval: "pending" })),
    ).toBe("awaits_authors");
    expect(
      transactionalSourceReason(source({ authorsApproval: "accepted" })),
    ).toBeNull();
    expect(
      transactionalSourcesMessage([
        source({ publishedAt: null }),
        source({ authorsApproval: "pending" }),
      ]),
    ).toBe(TRANSACTIONAL_SOURCE_MESSAGES.awaits_authors);
  });
});

describe("position of the main presenter", () => {
  const answerable = {
    status: "submitted" as const,
    admission: "admitted" as const,
    validatedAt: at,
    approvalMethod: null,
  };

  it("waits for the Secretaría and, when late, for the assembly", () => {
    expect(positionBlocker(answerable, "vote")).toBeNull();
    expect(
      positionBlocker(
        { ...answerable, admission: "pending", validatedAt: null },
        "vote",
      ),
    ).toBe("not_validated");
    expect(
      positionBlocker({ ...answerable, admission: "pending" }, "vote"),
    ).toBe("not_admitted");
  });

  it("waits for the main authors of a transactional", () => {
    expect(
      positionBlocker({ ...answerable, authorsApproval: "pending" }, "vote"),
    ).toBe("awaits_authors");
    expect(
      positionBlocker({ ...answerable, authorsApproval: "accepted" }, "vote"),
    ).toBeNull();
  });

  it("refuses decided amendments, except one its acceptance incorporated", () => {
    const incorporated = {
      ...answerable,
      status: "approved" as const,
      approvalMethod: "proponent" as const,
    };
    expect(positionBlocker(incorporated, "incorporate")).toBeNull();
    expect(positionBlocker(incorporated, "vote")).toBe("decided");
    expect(
      positionBlocker(
        { ...incorporated, approvalMethod: "vote" as const },
        "incorporate",
      ),
    ).toBe("decided");
  });

  it("incorporates an accepted amendment and reopens it when the answer changes", () => {
    const submitted = { status: "submitted" as const, approvalMethod: null };
    const incorporated = {
      status: "approved" as const,
      approvalMethod: "proponent" as const,
    };
    expect(positionEffect(submitted, "accept", "incorporate")).toBe("approve");
    expect(positionEffect(submitted, "reject", "incorporate")).toBeNull();
    expect(positionEffect(incorporated, "reject", "incorporate")).toBe(
      "reopen",
    );
    expect(positionEffect(incorporated, "pending", "incorporate")).toBe(
      "reopen",
    );
    expect(positionEffect(incorporated, "accept", "incorporate")).toBeNull();
  });

  it("decides nothing when accepted amendments are voted", () => {
    expect(
      positionEffect(
        { status: "submitted", approvalMethod: null },
        "accept",
        "vote",
      ),
    ).toBeNull();
  });
});

describe("countPositionsPending", () => {
  const amendment = (
    overrides: Partial<
      Parameters<typeof countPositionsPending>[0][number]
    > = {},
  ): Parameters<typeof countPositionsPending>[0][number] => ({
    status: "submitted",
    admission: "admitted",
    validatedAt: at,
    publishedAt: at,
    approvalMethod: null,
    authorsApproval: null,
    position: "pending",
    ...overrides,
  });

  it("counts undecided amendments without an answer", () => {
    expect(
      countPositionsPending(
        [
          amendment(),
          amendment({ position: null }),
          amendment({ position: "accept" }),
          amendment({ status: "approved" }),
        ],
        "vote",
      ),
    ).toBe(2);
  });

  it("counts only what the main presenter can answer now", () => {
    expect(
      countPositionsPending(
        [
          // pending_validation: not the presenter's turn yet.
          amendment({
            admission: "pending",
            validatedAt: null,
            publishedAt: null,
          }),
          // Late, waiting for the assembly's decision.
          amendment({ admission: "pending" }),
          // A transactional its main authors have not accepted yet.
          amendment({ authorsApproval: "pending" }),
          // A transactional that replaced its sources.
          amendment({ authorsApproval: "accepted" }),
          // Validated and kept private.
          amendment({ publishedAt: null }),
        ],
        "vote",
      ),
    ).toBe(2);
  });

  it("waits for publication when an answer can incorporate the amendment", () => {
    expect(
      countPositionsPending(
        [amendment(), amendment({ publishedAt: null })],
        "incorporate",
      ),
    ).toBe(1);
  });
});

describe("acceptedRulePlan", () => {
  const answered = {
    status: "submitted" as const,
    admission: "admitted" as const,
    validatedAt: at,
    publishedAt: at,
    approvalMethod: null,
    authorsApproval: null,
    position: "accept" as const,
  };

  it("incorporates what the main presenter already accepted", () => {
    expect(
      acceptedRulePlan(
        [
          { ...answered, id: "a" },
          { ...answered, id: "b", position: "reject" },
          { ...answered, id: "c", position: null },
          { ...answered, id: "d", publishedAt: null },
          { ...answered, id: "e", admission: "pending" },
          { ...answered, id: "f", authorsApproval: "pending" },
          { ...answered, id: "g", authorsApproval: "accepted" },
          { ...answered, id: "h", keepsSources: true },
          { ...answered, id: "i", status: "rejected" },
        ],
        "incorporate",
      ),
    ).toEqual({ approve: ["a", "g"], reopen: [] });
  });

  it("sends what the answer incorporated back to the vote", () => {
    const incorporated = {
      ...answered,
      status: "approved" as const,
      approvalMethod: "proponent" as const,
    };
    expect(
      acceptedRulePlan(
        [
          { ...incorporated, id: "a" },
          { ...incorporated, id: "b", approvalMethod: "vote" },
          { ...answered, id: "c" },
        ],
        "vote",
      ),
    ).toEqual({ approve: [], reopen: ["a"] });
  });
});

describe("transactionalReopenBlocker", () => {
  const open = {
    status: "submitted" as const,
    admission: "admitted" as const,
    validatedAt: at,
    decidedAt: null,
  };
  const transacted = { ...open, status: "transacted" as const, decidedAt: at };
  const transactional = {
    kind: "transactional" as const,
    validatedAt: at,
    authorsApproval: "accepted" as const,
    sources: [transacted],
  };

  it("reopens one that replaced what it groups", () => {
    expect(transactionalReopenBlocker(transactional)).toBeNull();
  });

  it("keeps closed one a main author rejected", () => {
    expect(
      transactionalReopenBlocker({
        ...transactional,
        authorsApproval: "rejected",
        sources: [open],
      }),
    ).toBe("rejected_by_author");
  });

  it("keeps closed one that never replaced sources no longer open", () => {
    // The Mesa's, validated at once, closed when another one replaced them.
    expect(
      transactionalReopenBlocker({
        ...transactional,
        authorsApproval: "pending",
        sources: [open, transacted],
      }),
    ).toBe("sources_closed");
    // A member's, still with the Secretaría.
    expect(
      transactionalReopenBlocker({
        ...transactional,
        validatedAt: null,
        sources: [transacted],
      }),
    ).toBe("sources_closed");
    expect(
      transactionalReopenBlocker({
        ...transactional,
        authorsApproval: "pending",
        sources: [open],
      }),
    ).toBeNull();
  });

  it("does not apply to other kinds", () => {
    expect(
      transactionalReopenBlocker({
        kind: "partial",
        validatedAt: null,
        authorsApproval: null,
        sources: [],
      }),
    ).toBeNull();
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

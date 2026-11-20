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
  awaitsPartyAnswer,
  awaitsPublication,
  awaitsValidation,
  countPositionsPending,
  hasPendingReview,
  isAmendmentPublishable,
  isPendingLateSource,
  isDocumentOverdue,
  mainAuthorOf,
  numberingToKeep,
  pickMainAuthor,
  positionBlocker,
  positionEffect,
  positionRecordedBy,
  publishOnValidation,
  reclassifyIncorporation,
  reclassifyPositionPlan,
  reviewInadmissionCase,
  shouldAutoAcceptPosition,
  POSITION_BLOCKER_MESSAGES,
  validationReopenBlocker,
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
    // Late and awaiting the assembly: a parent, replaced only once admitted.
    expect(unopenSourceReason(source({ admission: "pending" }))).toBeNull();
    expect(isPendingLateSource(source({ admission: "pending" }))).toBe(true);
    expect(isPendingLateSource(source())).toBe(false);
    expect(
      isPendingLateSource(source({ admission: "pending", validatedAt: null })),
    ).toBe(false);
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
    ).toBe(UNOPEN_SOURCE_MESSAGES.decided);
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
    ).toBe(TRANSACTIONAL_SOURCE_MESSAGES.not_published);
    // A late one awaiting the assembly may be grouped.
    expect(
      transactionalSourcesMessage([source({ admission: "pending" })]),
    ).toBe(null);
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
    publishedAt: at,
    approvalMethod: null,
  };

  it("waits for the Secretaría, not for the assembly to admit a late one", () => {
    expect(positionBlocker(answerable, "vote")).toBeNull();
    expect(
      positionBlocker(
        { ...answerable, admission: "pending", validatedAt: null },
        "vote",
      ),
    ).toBe("not_validated");
    // Late and validated: answered before the assembly decides.
    for (const rule of ["vote", "incorporate"] as const) {
      expect(
        positionBlocker({ ...answerable, admission: "pending" }, rule),
      ).toBeNull();
    }
    // Admitted by the Mesa before the Secretaría validated it (published
    // at once): answered as before.
    expect(
      positionBlocker({ ...answerable, validatedAt: null }, "vote"),
    ).toBeNull();
  });

  it("answers only what the main presenter can read, under either rule", () => {
    const kept = { ...answerable, publishedAt: null };
    expect(positionBlocker(kept, "vote")).toBe("not_published");
    expect(positionBlocker(kept, "incorporate")).toBe("not_published");
    // An office of the CEA reads it once validated, and answers it then.
    const seen = { ...kept, presenterSeesValidated: true };
    expect(positionBlocker(seen, "vote")).toBeNull();
    expect(positionBlocker(seen, "incorporate")).toBeNull();
    expect(
      positionBlocker(
        { ...seen, admission: "pending", validatedAt: null },
        "vote",
      ),
    ).toBe("not_validated");
    expect(
      positionBlocker({ ...seen, admission: "pending" }, "vote"),
    ).toBeNull();
    // Admitted by the Mesa but never validated: the office still waits.
    expect(positionBlocker({ ...seen, validatedAt: null }, "vote")).toBe(
      "not_published",
    );
    // A late one kept private waits for its publication too.
    expect(positionBlocker({ ...kept, admission: "pending" }, "vote")).toBe(
      "not_published",
    );
  });

  it("changes nothing once the document is voted", () => {
    expect(positionBlocker(answerable, "vote", true)).toBe("voted");
    expect(
      positionBlocker(
        {
          ...answerable,
          status: "approved",
          approvalMethod: "proponent",
        },
        "incorporate",
        true,
      ),
    ).toBe("voted");
    expect(POSITION_BLOCKER_MESSAGES.voted).toMatch(/votado/);
    expect(POSITION_BLOCKER_MESSAGES.not_published).toMatch(/publicado/);
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
    for (const status of [
      "withdrawn",
      "lapsed",
      "transacted",
      "inadmissible",
    ] as const) {
      for (const rule of ["vote", "incorporate"] as const) {
        expect(positionBlocker({ ...answerable, status }, rule)).toBe(
          "decided",
        );
      }
    }
  });

  it("keeps the answer open on a rejected one, which stays rejected", () => {
    for (const kind of ["partial", "formal", "transactional"] as const) {
      // Rejected by a vote (it has one): accepting it does not approve it.
      const rejected = {
        ...answerable,
        status: "rejected" as const,
        kind,
        outcomeVoteId: "vote1",
      };
      for (const rule of ["vote", "incorporate"] as const) {
        expect(positionBlocker(rejected, rule)).toBeNull();
        expect(positionBlocker(rejected, rule, true)).toBe("voted");
        for (const position of ["accept", "reject", "pending"] as const) {
          expect(positionEffect(rejected, position, rule)).toBeNull();
        }
      }
    }
    // A formal one the presenter's rejection closed still reopens.
    expect(
      positionEffect(
        {
          ...answerable,
          status: "rejected",
          kind: "formal",
          outcomeVoteId: null,
        },
        "accept",
        "incorporate",
      ),
    ).toBe("reopen_rejected");
  });

  it("keeps the answer open on what the assembly approved, until the final vote", () => {
    for (const approvalMethod of ["vote", "assent", "formal"] as const) {
      const approved = {
        ...answerable,
        status: "approved" as const,
        approvalMethod,
      };
      for (const rule of ["vote", "incorporate"] as const) {
        expect(positionBlocker(approved, rule)).toBeNull();
        expect(positionBlocker(approved, rule, true)).toBe("voted");
        // Recording it changes nothing else: no reopening, no approval.
        for (const position of ["accept", "reject", "pending"] as const) {
          expect(positionEffect(approved, position, rule)).toBeNull();
        }
      }
      // Decided, never on its way: unread by the presenter, it is closed.
      expect(positionBlocker({ ...approved, publishedAt: null }, "vote")).toBe(
        "decided",
      );
      expect(
        positionBlocker(
          { ...approved, publishedAt: null, presenterSeesValidated: true },
          "vote",
        ),
      ).toBeNull();
    }
    // Never counted as an answer still to give.
    expect(
      countPositionsPending(
        [
          {
            ...answerable,
            status: "approved",
            approvalMethod: "vote",
            authorsApproval: null,
            position: null,
          },
        ],
        "vote",
      ),
    ).toBe(0);
  });

  it("incorporates an accepted amendment and reopens it when the answer changes", () => {
    const submitted = {
      status: "submitted" as const,
      approvalMethod: null,
      admission: "admitted" as const,
    };
    const incorporated = {
      status: "approved" as const,
      approvalMethod: "proponent" as const,
      admission: "admitted" as const,
    };
    expect(positionEffect(submitted, "accept", "incorporate")).toBe("approve");
    expect(positionEffect(submitted, "reject", "incorporate")).toBeNull();
    // A late one waits for the assembly to admit it before going in.
    expect(
      positionEffect(
        { ...submitted, admission: "pending" },
        "accept",
        "incorporate",
      ),
    ).toBeNull();
    expect(positionEffect(incorporated, "reject", "incorporate")).toBe(
      "reopen",
    );
    expect(positionEffect(incorporated, "pending", "incorporate")).toBe(
      "reopen",
    );
    expect(positionEffect(incorporated, "accept", "incorporate")).toBeNull();
  });

  it("incorporates again an acceptance kept through the Mesa's reopening", () => {
    // Approved by a vote, then accepted: only the answer is recorded.
    const voted = {
      status: "approved" as const,
      approvalMethod: "vote" as const,
      admission: "admitted" as const,
    };
    expect(positionEffect(voted, "accept", "incorporate")).toBeNull();
    // Reopened, it is undecided with the acceptance kept: under
    // "incorporate" that acceptance approves it (incorporateOnAdmission
    // runs it at the end of the reopening), under "vote" it waits.
    const undecided = {
      ...voted,
      status: "submitted" as const,
      approvalMethod: null,
    };
    expect(positionEffect(undecided, "accept", "incorporate")).toBe("approve");
    expect(positionEffect(undecided, "accept", "vote")).toBeNull();
    // Not admitted (a late one an author withdrew before the assembly
    // decided): it waits for the admission, as before.
    expect(
      positionEffect(
        { ...undecided, admission: "pending" },
        "accept",
        "incorporate",
      ),
    ).toBeNull();
  });

  it("rejects a formal amendment its presenter rejects, and reopens it on another answer (2026-11-20)", () => {
    const formal = {
      status: "submitted" as const,
      approvalMethod: null,
      admission: "admitted" as const,
      kind: "formal" as const,
      outcomeVoteId: null,
    };
    for (const rule of ["incorporate", "vote"] as const) {
      expect(positionEffect(formal, "reject", rule)).toBe("reject");
      expect(
        positionEffect({ ...formal, kind: "partial" }, "reject", rule),
      ).toBeNull();
      // Not admitted yet (late): it waits.
      expect(
        positionEffect({ ...formal, admission: "pending" }, "reject", rule),
      ).toBeNull();
      const rejected = { ...formal, status: "rejected" as const };
      expect(positionEffect(rejected, "accept", rule)).toBe("reopen_rejected");
      expect(positionEffect(rejected, "pending", rule)).toBe("reopen_rejected");
      expect(positionEffect(rejected, "reject", rule)).toBeNull();
      // Rejected by a vote: the answer changes nothing.
      expect(
        positionEffect({ ...rejected, outcomeVoteId: "v1" }, "accept", rule),
      ).toBeNull();
    }
    // Without its kind and vote (callers that never decide), as before.
    expect(
      positionEffect(
        { status: "submitted", approvalMethod: null, admission: "admitted" },
        "reject",
        "incorporate",
      ),
    ).toBeNull();
  });

  it("keeps the answer of a formal amendment its rejection closed open", () => {
    const rejected = {
      status: "rejected" as const,
      admission: "admitted" as const,
      validatedAt: new Date(),
      publishedAt: new Date(),
      approvalMethod: null,
      kind: "formal" as const,
      outcomeVoteId: null,
    };
    expect(positionBlocker(rejected, "vote")).toBeNull();
    expect(positionBlocker(rejected, "incorporate")).toBeNull();
    // Rejected by a vote: answered too (2026-11-21), without effect.
    expect(
      positionBlocker({ ...rejected, outcomeVoteId: "v1" }, "vote"),
    ).toBeNull();
    expect(
      positionBlocker({ ...rejected, kind: "partial" }, "vote"),
    ).toBeNull();
    expect(positionBlocker(rejected, "vote", true)).toBe("voted");
  });

  it("decides nothing when accepted amendments are voted", () => {
    expect(
      positionEffect(
        { status: "submitted", approvalMethod: null, admission: "admitted" },
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
          // Late, validated, waiting for the assembly's decision: it can
          // be answered already.
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

  it("waits for publication under either rule", () => {
    for (const rule of ["vote", "incorporate"] as const) {
      expect(
        countPositionsPending(
          [amendment(), amendment({ publishedAt: null })],
          rule,
        ),
      ).toBe(1);
    }
  });
});

describe("acceptedRulePlan", () => {
  const answered = {
    kind: "partial" as const,
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
          // A formal one always follows "incorporate" (2026-11-20).
          { ...incorporated, id: "d", kind: "formal" },
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

  it("keeps an area's code when another area presents it again: they share CEA", () => {
    expect(
      numberingToKeep({ number: 7, memberSeq: 3, code: "CEA 3" }, "CEA"),
    ).toEqual({ number: 7, memberSeq: 3 });
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

describe("positionRecordedBy", () => {
  it("says an answer given by itself is automatic", () => {
    expect(
      positionRecordedBy({
        decidedByUserId: "secretaria",
        recordedAs: "auto",
        recorderMemberId: "se",
        mainPresenterId: "main",
      }),
    ).toBe("auto");
  });

  it("says the main presenter answered when its own account did", () => {
    expect(
      positionRecordedBy({
        decidedByUserId: "u1",
        recorderMemberId: "main",
        mainPresenterId: "main",
      }),
    ).toBe("presenter");
  });

  it("says the Mesa recorded it when someone else did", () => {
    expect(
      positionRecordedBy({
        decidedByUserId: "u2",
        recorderMemberId: "mesa",
        mainPresenterId: "main",
      }),
    ).toBe("mesa");
    // An account that acts for no member, or one no longer found.
    expect(
      positionRecordedBy({
        decidedByUserId: "u2",
        recorderMemberId: null,
        mainPresenterId: "main",
      }),
    ).toBe("mesa");
    expect(
      positionRecordedBy({
        decidedByUserId: "u2",
        recorderMemberId: undefined,
        mainPresenterId: null,
      }),
    ).toBe("mesa");
  });

  it("counts a row nobody answered as the presenter's", () => {
    expect(
      positionRecordedBy({
        decidedByUserId: null,
        recorderMemberId: null,
        mainPresenterId: "main",
      }),
    ).toBe("presenter");
  });

  it("keeps who recorded it when the document gets another main presenter", () => {
    // The former main presenter answered; "new" presents it now.
    expect(
      positionRecordedBy({
        decidedByUserId: "u1",
        recordedAs: "proponent",
        recorderMemberId: "former",
        mainPresenterId: "new",
      }),
    ).toBe("presenter");
    // The Mesa answered for a main presenter whose account it shares now.
    expect(
      positionRecordedBy({
        decidedByUserId: "u2",
        recordedAs: "moderator",
        recorderMemberId: "new",
        mainPresenterId: "new",
      }),
    ).toBe("mesa");
    // Also when the user who recorded it is gone.
    expect(
      positionRecordedBy({
        decidedByUserId: null,
        recordedAs: "moderator",
        recorderMemberId: null,
        mainPresenterId: "main",
      }),
    ).toBe("mesa");
  });

  it("compares members when the event does not say", () => {
    expect(
      positionRecordedBy({
        decidedByUserId: "u1",
        recordedAs: undefined,
        recorderMemberId: "main",
        mainPresenterId: "main",
      }),
    ).toBe("presenter");
    expect(
      positionRecordedBy({
        decidedByUserId: "u2",
        recordedAs: "something else",
        recorderMemberId: "other",
        mainPresenterId: "main",
      }),
    ).toBe("mesa");
  });
});

describe("publishOnValidation", () => {
  it("publishes as the Secretaría chose", () => {
    expect(publishOnValidation({ kind: "partial" }, true)).toBe(true);
    expect(publishOnValidation({ kind: "partial" }, false)).toBe(false);
  });

  it("always publishes a transactional", () => {
    expect(publishOnValidation({ kind: "transactional" }, false)).toBe(true);
    expect(publishOnValidation({ kind: "transactional" }, true)).toBe(true);
  });

  it("always publishes a formal amendment (2026-11-20)", () => {
    expect(publishOnValidation({ kind: "formal" }, false)).toBe(true);
  });
});

describe("formal amendments follow incorporate whatever the document (2026-11-20)", () => {
  const formal = {
    status: "submitted" as const,
    approvalMethod: null,
    admission: "admitted" as const,
    kind: "formal" as const,
    outcomeVoteId: null,
  };
  const incorporated = {
    ...formal,
    status: "approved" as const,
    approvalMethod: "proponent" as const,
  };

  it("incorporates an accepted formal amendment under the vote rule", () => {
    expect(positionEffect(formal, "accept", "vote")).toBe("approve");
    expect(
      positionEffect({ ...formal, kind: "partial" }, "accept", "vote"),
    ).toBeNull();
    // A late one waits for the assembly's admission.
    expect(
      positionEffect({ ...formal, admission: "pending" }, "accept", "vote"),
    ).toBeNull();
  });

  it("rejects an incorporated formal amendment its presenter rejects", () => {
    for (const rule of ["incorporate", "vote"] as const) {
      expect(positionEffect(incorporated, "reject", rule)).toBe("reject");
      expect(positionEffect(incorporated, "pending", rule)).toBe("reopen");
      expect(positionEffect(incorporated, "accept", rule)).toBeNull();
    }
  });

  it("takes out what stopped being formal under the vote rule", () => {
    const partial = { ...incorporated, kind: "partial" as const };
    expect(positionEffect(partial, "pending", "vote")).toBe("reopen");
  });

  it("keeps the answer of an incorporated formal one open under the vote rule", () => {
    const row = {
      ...incorporated,
      validatedAt: at,
      publishedAt: at,
    };
    expect(positionBlocker(row, "vote")).toBeNull();
    expect(positionBlocker({ ...row, kind: "partial" }, "vote")).toBe(
      "decided",
    );
  });

  it("follows the new kind's rule when reclassified with an acceptance by hand", () => {
    const submitted = {
      status: "submitted" as const,
      approvalMethod: null,
      admission: "admitted" as const,
    };
    const approved = {
      ...submitted,
      status: "approved" as const,
      approvalMethod: "proponent" as const,
    };
    expect(reclassifyIncorporation(submitted, "formal", "accept", "vote")).toBe(
      "approve",
    );
    expect(
      reclassifyIncorporation(submitted, "formal", "reject", "vote"),
    ).toBeNull();
    expect(
      reclassifyIncorporation(
        { ...submitted, admission: "pending" },
        "formal",
        "accept",
        "vote",
      ),
    ).toBeNull();
    expect(reclassifyIncorporation(approved, "partial", "accept", "vote")).toBe(
      "reopen",
    );
    expect(
      reclassifyIncorporation(approved, "partial", "accept", "incorporate"),
    ).toBeNull();
    expect(
      reclassifyIncorporation(submitted, "partial", "accept", "vote"),
    ).toBeNull();
  });
});

describe("awaitsPartyAnswer", () => {
  const open = {
    status: "submitted" as const,
    memberId: "m1",
    parties: [
      { memberId: "m1", decision: "pending" as const },
      { memberId: "m2", decision: "accepted" as const },
    ],
    sourcesOpen: true,
    voted: false,
  };

  it("asks a party that has not answered a transactional it can still take", () => {
    expect(awaitsPartyAnswer(open)).toBe(true);
    expect(awaitsPartyAnswer({ ...open, memberId: "m2" })).toBe(false);
    expect(awaitsPartyAnswer({ ...open, memberId: "m3" })).toBe(false);
    expect(awaitsPartyAnswer({ ...open, memberId: null })).toBe(false);
  });

  it("stops asking once it cannot go through", () => {
    expect(awaitsPartyAnswer({ ...open, sourcesOpen: false })).toBe(false);
    expect(awaitsPartyAnswer({ ...open, status: "withdrawn" })).toBe(false);
    expect(awaitsPartyAnswer({ ...open, status: "draft" })).toBe(false);
    expect(awaitsPartyAnswer({ ...open, voted: true })).toBe(false);
  });
});

describe("validationReopenBlocker", () => {
  const at = new Date("2026-03-10T12:00:00Z");
  const row = {
    status: "submitted" as const,
    validatedAt: at,
    kind: "partial" as const,
    late: false,
    admission: "admitted" as const,
  };

  it("lets a validated, undecided amendment go back, published or not", () => {
    expect(validationReopenBlocker(row)).toBeNull();
    expect(
      validationReopenBlocker({ ...row, late: true, admission: "pending" }),
    ).toBeNull();
  });

  it("refuses one not validated, decided, a transactional or admitted late", () => {
    expect(
      validationReopenBlocker({ ...row, validatedAt: null }),
    ).not.toBeNull();
    expect(
      validationReopenBlocker({ ...row, status: "rejected" }),
    ).not.toBeNull();
    expect(
      validationReopenBlocker({ ...row, kind: "transactional" }),
    ).not.toBeNull();
    expect(validationReopenBlocker({ ...row, late: true })).not.toBeNull();
  });
});

describe("reviewInadmissionCase", () => {
  const at = new Date("2026-03-10T12:00:00Z");
  const waiting = {
    status: "submitted" as const,
    validatedAt: null,
    correctionRequestedAt: null,
    authorsApproval: null,
    kind: "partial" as const,
    late: false,
    admission: "pending" as const,
  };
  const validated = {
    ...waiting,
    validatedAt: at,
    admission: "admitted" as const,
  };

  it("takes one waiting for its check, late or not", () => {
    expect(reviewInadmissionCase(waiting)).toBe("unvalidated");
    expect(reviewInadmissionCase({ ...waiting, late: true })).toBe(
      "unvalidated",
    );
  });

  it("takes one validated that can still go back to review, on time", () => {
    expect(reviewInadmissionCase(validated)).toBe("validated");
    expect(
      reviewInadmissionCase({ ...validated, late: true, admission: "pending" }),
    ).toBeNull();
    expect(
      reviewInadmissionCase({ ...validated, kind: "transactional" }),
    ).toBeNull();
  });

  it("takes a draft already sent back for a correction", () => {
    expect(
      reviewInadmissionCase({
        ...waiting,
        status: "draft",
        correctionRequestedAt: at,
      }),
    ).toBe("returned");
    expect(reviewInadmissionCase({ ...waiting, status: "draft" })).toBeNull();
  });

  it("refuses decided ones and a transactional waiting for its authors", () => {
    for (const status of [
      "approved",
      "rejected",
      "withdrawn",
      "lapsed",
      "transacted",
      "inadmissible",
    ] as const) {
      expect(reviewInadmissionCase({ ...validated, status })).toBeNull();
    }
    expect(
      reviewInadmissionCase({
        ...waiting,
        kind: "transactional",
        authorsApproval: "pending",
      }),
    ).toBeNull();
  });
});

describe("automatic answer to formal amendments", () => {
  const row = {
    status: "submitted" as const,
    admission: "admitted" as const,
    validatedAt: at,
    publishedAt: at,
    approvalMethod: null,
  };
  const answerable = { ...row, kind: "formal" as const };

  it("accepts a formal amendment once it can be answered and nobody did", () => {
    expect(shouldAutoAcceptPosition(answerable, null, "vote")).toBe(true);
    expect(shouldAutoAcceptPosition(answerable, "pending", "incorporate")).toBe(
      true,
    );
  });

  it("keeps an answer already given", () => {
    for (const position of ["accept", "reject", "transact"] as const) {
      expect(shouldAutoAcceptPosition(answerable, position, "vote")).toBe(
        false,
      );
    }
  });

  it("waits until it can be answered, and never after the final vote", () => {
    expect(
      shouldAutoAcceptPosition(
        { ...answerable, publishedAt: null },
        null,
        "vote",
      ),
    ).toBe(false);
    // Validated is enough when an office of the CEA presents the document.
    expect(
      shouldAutoAcceptPosition(
        { ...answerable, publishedAt: null, presenterSeesValidated: true },
        null,
        "vote",
      ),
    ).toBe(true);
    // Late and validated: answered before the assembly decides.
    expect(
      shouldAutoAcceptPosition(
        { ...answerable, admission: "pending" },
        null,
        "vote",
      ),
    ).toBe(true);
    expect(
      shouldAutoAcceptPosition(
        { ...answerable, admission: "pending", validatedAt: null },
        null,
        "vote",
      ),
    ).toBe(false);
    expect(shouldAutoAcceptPosition(answerable, null, "vote", true)).toBe(
      false,
    );
    expect(
      shouldAutoAcceptPosition(
        { ...answerable, status: "lapsed" },
        "pending",
        "vote",
      ),
    ).toBe(false);
  });

  it("never answers content amendments nor transactionals", () => {
    expect(
      shouldAutoAcceptPosition(
        { ...answerable, kind: "partial" },
        null,
        "vote",
      ),
    ).toBe(false);
    expect(
      shouldAutoAcceptPosition(
        {
          ...answerable,
          kind: "transactional",
          authorsApproval: "accepted",
        },
        null,
        "vote",
      ),
    ).toBe(false);
  });

  it("accepts a content amendment made formal while unanswered", () => {
    expect(reclassifyPositionPlan(row, "formal", null, undefined, "vote")).toBe(
      "accept",
    );
    expect(
      reclassifyPositionPlan(row, "formal", "reject", "proponent", "vote"),
    ).toBeNull();
    // Not answerable yet: validating and publishing it will.
    expect(
      reclassifyPositionPlan(
        { ...row, validatedAt: null, admission: "pending", publishedAt: null },
        "formal",
        "pending",
        undefined,
        "vote",
      ),
    ).toBeNull();
    expect(
      reclassifyPositionPlan(row, "formal", null, undefined, "vote", true),
    ).toBeNull();
  });

  it("takes back the automatic acceptance when it stops being formal", () => {
    expect(
      reclassifyPositionPlan(row, "partial", "accept", "auto", "vote"),
    ).toBe("pending");
    // Incorporated by that acceptance: going back to pending reopens it.
    const incorporated = {
      ...row,
      status: "approved" as const,
      approvalMethod: "proponent" as const,
    };
    expect(
      reclassifyPositionPlan(
        incorporated,
        "partial",
        "accept",
        "auto",
        "incorporate",
      ),
    ).toBe("pending");
    expect(positionEffect(incorporated, "pending", "incorporate")).toBe(
      "reopen",
    );
  });

  it("keeps an answer given by hand when it stops being formal", () => {
    for (const by of ["proponent", "moderator", undefined]) {
      expect(
        reclassifyPositionPlan(row, "partial", "accept", by, "vote"),
      ).toBeNull();
    }
    expect(
      reclassifyPositionPlan(row, "partial", "pending", "auto", "vote"),
    ).toBeNull();
  });
});

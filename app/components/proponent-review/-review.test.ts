import { describe, expect, it } from "vitest";
import type {
  AcceptanceDto,
  AmendmentDto,
  PositionDto,
} from "~~/shared/types/api";
import {
  amendmentAwaitsPosition,
  amendmentPositionBlocker,
} from "~/composables/amendment/workspace";
import {
  acceptHelpKey,
  amendmentOutcome,
  answeredByMesa,
  answerStatus,
  commentUnsaved,
  emptyReviewReason,
  fallbackStep,
  firstPendingId,
  goneKey,
  initialStep,
  isIncorporated,
  isPositionAnswerable,
  isPositionAnswered,
  isPositionReviewable,
  positionBody,
  positionConflict,
  positionCounts,
  positionWaitCounts,
  positionWaitReason,
  presenterAnswerItems,
  presenterAnswerKey,
  proponentReviewItems,
  proponentReviewProgress,
  recordedPositionCounts,
  reviewSequence,
  savedKey,
  seenPositionAt,
  stateKey,
  stepAfter,
  stepBefore,
  stepCounter,
  visibleAnswerProgress,
  wasReopened,
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
    mainAuthorId: CEUM.id,
    submittedAt: "2026-11-01T10:00:00.000Z",
    validatedAt: "2026-11-01T11:00:00.000Z",
    publishedAt: "2026-11-01T11:00:00.000Z",
    reviewState: "published",
    correctionNote: null,
    decidedAt: null,
    approvalMethod: null,
    outcomeNote: null,
    outcomeVote: null,
    position: {
      position: "pending",
      comment: null,
      recordedBy: "presenter",
      updatedAt: "",
    },
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
  decision: AcceptanceDto["decision"] = "pending",
  role: AcceptanceDto["role"] = "author",
): AcceptanceDto {
  return {
    member,
    role,
    decision,
    decidedAt: null,
    recordedBy: "party" as const,
  };
}

/** A transactional its main authors accepted and the Secretaría published. */
function transactional(id: string, overrides: Overrides = {}): AmendmentDto {
  return amendment(id, {
    kind: "transactional",
    code: `T${id}`,
    number: null,
    authors: [CEA],
    mainAuthorId: CEA.id,
    sourceIds: ["s1", "s2"],
    acceptances: [party(CEUM, "accepted"), party(CEA, "accepted")],
    ...overrides,
  });
}

/** An answer on record, given by the main presenter unless said otherwise. */
function answered(
  position: "accept" | "reject" | "transact",
  recordedBy: PositionDto["recordedBy"] = "presenter",
): PositionDto {
  return {
    position,
    comment: null,
    recordedBy,
    updatedAt: "2026-11-02T10:00:00.000Z",
  };
}

/** An answer the Mesa recorded on the main presenter's behalf. */
function byMesa(position: "accept" | "reject" | "transact"): PositionDto {
  return answered(position, "mesa");
}

/** Accepted under the "incorporate" rule: approved at once. */
function incorporated(id: string, overrides: Overrides = {}): AmendmentDto {
  return amendment(id, {
    status: "approved",
    approvalMethod: "proponent",
    decidedAt: "2026-11-02T10:00:00.000Z",
    position: answered("accept"),
    ...overrides,
  });
}

/** Validated by the Secretaría and kept private. */
function privateOne(id: string, overrides: Overrides = {}): AmendmentDto {
  return amendment(id, {
    reviewState: "validated",
    publishedAt: null,
    ...overrides,
  });
}

describe("positions", () => {
  it("counts a null or pending position as not answered", () => {
    expect(isPositionAnswered(amendment("a", { position: null }))).toBe(false);
    expect(isPositionAnswered(amendment("a"))).toBe(false);
    expect(
      isPositionAnswered(amendment("a", { position: answered("reject") })),
    ).toBe(true);
  });

  it("answers validated, admitted and undecided amendments", () => {
    for (const rule of ["vote", "incorporate"] as const) {
      expect(isPositionReviewable(amendment("a"), rule)).toBe(true);
      // Recorded before validation existed: public.
      expect(
        isPositionReviewable(amendment("a", { reviewState: null }), rule),
      ).toBe(true);
      expect(
        isPositionReviewable(
          amendment("a", {
            reviewState: "pending_validation",
            validatedAt: null,
            admission: "pending",
          }),
          rule,
        ),
      ).toBe(false);
      expect(
        isPositionReviewable(amendment("a", { status: "rejected" }), rule),
      ).toBe(false);
      expect(
        isPositionReviewable(
          amendment("a", { can: { position: false } }),
          rule,
        ),
      ).toBe(false);
    }
  });

  it("waits for the Secretaría to publish a validated private one, whatever the rule", () => {
    // Only published amendments are answered: delegates cannot read a
    // private one, so the presenter does not answer it yet.
    for (const rule of ["vote", "incorporate"] as const) {
      expect(isPositionReviewable(privateOne("a"), rule)).toBe(false);
      expect(isPositionAnswerable(privateOne("a"), rule)).toBe(false);
      expect(positionWaitReason(privateOne("a"), rule)).toBe("publication");
      // Even for the Mesa, which sees it and may answer for the presenter.
      expect(
        isPositionReviewable(
          privateOne("a", { can: { position: true, moderate: true } }),
          rule,
        ),
      ).toBe(false);
    }
  });

  it("only waits for publication while the amendment is undecided", () => {
    expect(positionWaitReason(amendment("a"), "vote")).toBeNull();
    // Recorded before validation existed: public.
    expect(
      positionWaitReason(amendment("a", { reviewState: null }), "vote"),
    ).toBeNull();
    // Still with the Secretaría: that is what it waits for.
    expect(
      positionWaitReason(
        amendment("a", {
          reviewState: "pending_validation",
          validatedAt: null,
          admission: "pending",
        }),
        "vote",
      ),
    ).toBe("validation");
    expect(
      positionWaitReason(privateOne("a", { status: "lapsed" }), "vote"),
    ).toBe("decided");
  });

  it("answers nothing once the document is voted", () => {
    const voted = { finalVoted: true };
    for (const rule of ["vote", "incorporate"] as const) {
      expect(positionWaitReason(amendment("a"), rule, voted)).toBe("decided");
      expect(isPositionAnswerable(amendment("a"), rule, voted)).toBe(false);
      expect(isPositionReviewable(amendment("a"), rule, voted)).toBe(false);
    }
    // Not even one the presenter's acceptance incorporated.
    expect(isPositionReviewable(incorporated("a"), "incorporate")).toBe(true);
    expect(isPositionReviewable(incorporated("a"), "incorporate", voted)).toBe(
      false,
    );
    // Nothing is on its way any more either.
    expect(
      positionWaitCounts(
        [amendment("a", { late: true, admission: "pending" }), privateOne("b")],
        "vote",
        voted,
      ),
    ).toEqual({ authors: 0, validation: 0, admission: 0, publication: 0 });
    // Without the context, the amendment-level rule as before.
    expect(
      positionWaitReason(amendment("a"), "vote", { finalVoted: false }),
    ).toBeNull();
  });

  it("waits for the assembly to admit a late amendment", () => {
    const late = amendment("a", { late: true, admission: "pending" });
    expect(isPositionReviewable(late, "vote")).toBe(false);
    expect(positionWaitReason(late, "vote")).toBe("admission");
    expect(
      isPositionReviewable(
        amendment("a", { late: true, admission: "admitted" }),
        "vote",
      ),
    ).toBe(true);
    expect(
      positionWaitCounts(
        [
          late,
          amendment("b"),
          // Still with the Secretaría: not the assembly's call yet.
          amendment("c", {
            late: true,
            admission: "pending",
            reviewState: "pending_validation",
            validatedAt: null,
          }),
          amendment("d", {
            late: true,
            admission: "inadmissible",
            status: "inadmissible",
          }),
        ],
        "vote",
      ),
    ).toEqual({ admission: 1, validation: 1, authors: 0, publication: 0 });
  });

  it("keeps an incorporated amendment while its answer can still change", () => {
    expect(isIncorporated(incorporated("a"))).toBe(true);
    expect(isPositionReviewable(incorporated("a"), "incorporate")).toBe(true);
    // The rule changed to "vote" afterwards: as the server, it is decided.
    expect(isPositionReviewable(incorporated("a"), "vote")).toBe(false);
    expect(positionWaitReason(incorporated("a"), "vote")).toBe("decided");
    // Approved by the assembly: decided for good.
    expect(
      isPositionReviewable(
        amendment("a", {
          status: "approved",
          approvalMethod: "vote",
          position: answered("accept"),
        }),
        "incorporate",
      ),
    ).toBe(false);
    expect(
      isPositionReviewable(amendment("a", { status: "transacted" }), "vote"),
    ).toBe(false);
  });

  it("does not depend on who looks", () => {
    expect(
      isPositionAnswerable(
        amendment("a", { can: { position: false } }),
        "vote",
      ),
    ).toBe(true);
  });

  it("gives the document page's reason for every amendment still on its way", () => {
    const onTheirWay = [
      amendment("late", { late: true, admission: "pending" }),
      amendment("new", {
        reviewState: "pending_validation",
        validatedAt: null,
        publishedAt: null,
        admission: "pending",
      }),
      // Admitted by the Mesa before the Secretaría validated it: still
      // with the Secretaría.
      amendment("early", {
        late: true,
        reviewState: "pending_validation",
        validatedAt: null,
        publishedAt: null,
      }),
      transactional("t", {
        acceptances: [party(CEUM, "accepted"), party(CEA)],
      }),
    ];
    for (const rule of ["vote", "incorporate"] as const) {
      for (const one of onTheirWay) {
        expect(positionWaitReason(one, rule)).toBe(
          amendmentPositionBlocker(one, rule),
        );
      }
      // Validated and admitted, a private one only waits for the
      // Secretaría to publish it.
      expect(positionWaitReason(privateOne("private"), rule)).toBe(
        "publication",
      );
    }
    expect(positionWaitReason(onTheirWay[2]!, "vote")).toBe("validation");
  });

  it("reads the workspace's rule with the same document context", () => {
    const all = [
      amendment("open"),
      incorporated("in"),
      privateOne("private"),
      amendment("late", { late: true, admission: "pending" }),
      amendment("done", { status: "rejected" }),
      transactional("t", { acceptances: [party(CEA)] }),
    ];
    for (const rule of ["vote", "incorporate"] as const) {
      for (const context of [{}, { finalVoted: false }, { finalVoted: true }]) {
        for (const one of all) {
          const expected = amendmentAwaitsPosition(one, rule, context)
            ? null
            : (amendmentPositionBlocker(one, rule, context) ?? "decided");
          expect(positionWaitReason(one, rule, context)).toBe(expected);
        }
      }
    }
  });

  it("keeps an incorporated amendment answerable by its own rule until the vote", () => {
    // What the page reads when a step leaves the review before the document
    // is refreshed: still answerable on its own, so it left because of the
    // document (its vote) or the actor's rights, not because someone decided
    // it.
    expect(isPositionAnswerable(incorporated("a"), "incorporate")).toBe(true);
    expect(
      isPositionReviewable(
        incorporated("a", { can: { position: false } }),
        "incorporate",
      ),
    ).toBe(false);
    expect(
      isPositionAnswerable(incorporated("a"), "incorporate", {
        finalVoted: true,
      }),
    ).toBe(false);
    // Under "vote" an accepted one is never approved by the answer itself,
    // so an approved one is decided.
    expect(isPositionAnswerable(incorporated("a"), "vote")).toBe(false);
  });
});

describe("transactionals", () => {
  it("is answered once its main authors accepted it and it was published", () => {
    expect(positionWaitReason(transactional("1"), "vote")).toBeNull();
    expect(isPositionReviewable(transactional("1"), "vote")).toBe(true);
    // Accepted and validated, but still private: it waits for publication.
    for (const rule of ["vote", "incorporate"] as const) {
      expect(
        positionWaitReason(
          transactional("2", { reviewState: "validated", publishedAt: null }),
          rule,
        ),
      ).toBe("publication");
    }
  });

  it("waits while a main author has not accepted it", () => {
    // Drafted live by the Mesa: published at once, authors still to answer.
    const live = transactional("1", {
      acceptances: [party(CEUM, "accepted"), party(CEA)],
    });
    expect(isPositionReviewable(live, "vote")).toBe(false);
    expect(positionWaitReason(live, "vote")).toBe("authors");
    // Proposed by a member: with the main authors, not yet validated. The
    // authors are the next step, so that is the reason given.
    expect(
      positionWaitReason(
        transactional("2", {
          reviewState: "pending_authors",
          admission: "pending",
          validatedAt: null,
          publishedAt: null,
          acceptances: [party(CEUM)],
        }),
        "vote",
      ),
    ).toBe("authors");
    // Accepted by the authors, still with the Secretaría.
    expect(
      positionWaitReason(
        transactional("3", {
          reviewState: "pending_validation",
          admission: "pending",
          validatedAt: null,
          publishedAt: null,
        }),
        "vote",
      ),
    ).toBe("validation");
    // A main author rejected it: the server closes it (withdrawn) and the
    // originals carry on.
    expect(
      positionWaitReason(
        transactional("4", {
          status: "withdrawn",
          acceptances: [party(CEUM, "rejected"), party(CEA, "accepted")],
        }),
        "vote",
      ),
    ).toBe("decided");
  });

  it("only counts the main authors' answers", () => {
    // A row left by the removed step where the presenter approved
    // transactionals does not hold it back, as on the server.
    const legacy = transactional("1", {
      acceptances: [
        party(CEUM, "accepted"),
        party(CEA, "accepted"),
        party(CEA, "pending", "proponent"),
      ],
    });
    expect(positionWaitReason(legacy, "vote")).toBeNull();
    expect(isPositionReviewable(legacy, "vote")).toBe(true);
  });

  it("treats every other amendment as having nobody to wait for", () => {
    expect(
      positionWaitReason(
        amendment("a", { acceptances: [party(CEUM, "pending")] }),
        "vote",
      ),
    ).toBeNull();
  });

  it("lists a transactional in place of the amendments it replaced", () => {
    const items = proponentReviewItems(
      [
        amendment("s1", { status: "transacted", positionKey: 1 }),
        amendment("s2", { status: "transacted", positionKey: 2 }),
        transactional("1", { positionKey: 3 }),
        transactional("2", {
          positionKey: 4,
          acceptances: [party(CEUM, "accepted"), party(CEA)],
        }),
      ],
      "vote",
    );
    expect(items.map((item) => item.id)).toEqual(["1"]);
    expect(
      positionWaitCounts(
        [
          transactional("2", {
            acceptances: [party(CEUM, "accepted"), party(CEA)],
          }),
        ],
        "vote",
      ).authors,
    ).toBe(1);
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

describe("saving", () => {
  it("sends the answer, the trimmed comment and the position it saw", () => {
    expect(
      positionBody(
        "accept",
        "  De acuerdo ",
        amendment("a", { position: answered("reject") }),
      ),
    ).toEqual({
      position: "accept",
      comment: "De acuerdo",
      positionUpdatedAt: "2026-11-02T10:00:00.000Z",
    });
    // Nothing answered yet, or positions hidden: null, never "".
    expect(positionBody("reject", "   ", amendment("a"))).toEqual({
      position: "reject",
      comment: null,
      positionUpdatedAt: null,
    });
    expect(
      positionBody("transact", "", amendment("a", { position: null }))
        .positionUpdatedAt,
    ).toBeNull();
    expect(seenPositionAt(amendment("a"))).toBeNull();
  });

  it("tells why an answer was refused", () => {
    const sent = seenPositionAt(amendment("a"));
    expect(
      positionConflict(
        sent,
        amendment("a", { position: answered("reject") }),
        true,
        "vote",
      ),
    ).toBe("answered");
    expect(positionConflict(sent, amendment("a"), true, "vote")).toBe(
      "changed",
    );
    expect(
      positionConflict(
        sent,
        amendment("a", { status: "withdrawn" }),
        false,
        "vote",
      ),
    ).toBe("gone");
    expect(positionConflict(sent, undefined, true, "vote")).toBe("gone");
    // Out of the review and waiting for someone: says for whom.
    expect(
      positionConflict(
        sent,
        amendment("a", { late: true, admission: "pending" }),
        false,
        "vote",
      ),
    ).toBe("admission");
    expect(
      positionConflict(
        sent,
        transactional("t", {
          acceptances: [party(CEUM, "accepted"), party(CEA)],
        }),
        false,
        "vote",
      ),
    ).toBe("authors");
    for (const rule of ["vote", "incorporate"] as const) {
      expect(positionConflict(sent, privateOne("a"), false, rule)).toBe(
        "publication",
      );
    }
    // Out of the review with nothing to wait for: the document changed.
    expect(positionConflict(sent, amendment("a"), false, "vote")).toBe(
      "changed",
    );
  });

  it("says when the document's final vote refused the answer", () => {
    const sent = seenPositionAt(amendment("a"));
    const voted = { finalVoted: true };
    expect(positionConflict(sent, amendment("a"), false, "vote", voted)).toBe(
      "voted",
    );
    expect(
      positionConflict(sent, incorporated("a"), false, "incorporate", voted),
    ).toBe("voted");
    expect(positionConflict(sent, undefined, false, "vote", voted)).toBe(
      "voted",
    );
  });

  it("treats an amendment a transactional replaced meanwhile as gone", () => {
    const sent = seenPositionAt(amendment("a"));
    expect(
      positionConflict(
        sent,
        amendment("a", { status: "transacted" }),
        false,
        "vote",
      ),
    ).toBe("gone");
    // Incorporated meanwhile by someone else's answer: still in the review
    // under "incorporate", with an answer the actor did not see.
    expect(positionConflict(sent, incorporated("a"), true, "incorporate")).toBe(
      "answered",
    );
  });

  it("says when a transactional took the place of the amendment that left", () => {
    expect(goneKey(amendment("a", { status: "transacted" }))).toBe(
      "goneTransacted",
    );
    expect(goneKey(amendment("a", { status: "withdrawn" }))).toBe("gone");
    expect(goneKey(amendment("a", { status: "approved" }))).toBe("gone");
    expect(goneKey(null)).toBe("gone");
    expect(goneKey(undefined)).toBe("gone");
  });

  it("explains Aceptar by the document's rule", () => {
    expect(acceptHelpKey("incorporate")).toBe("acceptHelpIncorporate");
    expect(acceptHelpKey("vote")).toBe("acceptHelpVote");
  });

  it("says when an answer incorporated the amendment or took it out", () => {
    expect(savedKey("accept", incorporated("a"))).toBe("incorporated");
    expect(savedKey("accept", amendment("a"))).toBe("accept");
    expect(savedKey("reject", amendment("a"))).toBe("reject");
    expect(wasReopened(incorporated("a"), amendment("a"))).toBe(true);
    expect(wasReopened(amendment("a"), amendment("a"))).toBe(false);
    expect(wasReopened(incorporated("a"), incorporated("a"))).toBe(false);
  });
});

describe("stateKey", () => {
  it("reads where the answer leaves the amendment under the rule", () => {
    expect(stateKey(amendment("a"), "vote", false)).toBe("pending");
    expect(
      stateKey(amendment("a", { position: answered("accept") }), "vote", false),
    ).toBe("acceptVote");
    expect(stateKey(incorporated("a"), "incorporate", false)).toBe(
      "incorporated",
    );
    expect(
      stateKey(
        amendment("a", { position: answered("accept") }),
        "incorporate",
        false,
      ),
    ).toBe("accept");
    expect(
      stateKey(
        amendment("a", { position: answered("reject") }),
        "incorporate",
        false,
      ),
    ).toBe("reject");
  });

  it("names the member when the Mesa answers for it", () => {
    expect(stateKey(amendment("a"), "vote", true)).toBe("pendingFor");
    expect(
      stateKey(amendment("a", { position: answered("accept") }), "vote", true),
    ).toBe("acceptVoteFor");
    expect(stateKey(incorporated("a"), "incorporate", true)).toBe(
      "incorporatedFor",
    );
    expect(
      stateKey(
        amendment("a", { position: answered("transact") }),
        "vote",
        true,
      ),
    ).toBe("transactFor");
  });

  it("says when the Mesa recorded the answer on the presenter's behalf", () => {
    // The main presenter reads it: "La Mesa, en tu nombre, ...".
    expect(
      stateKey(amendment("a", { position: byMesa("accept") }), "vote", false),
    ).toBe("acceptVoteByMesa");
    expect(
      stateKey(
        amendment("a", { position: byMesa("accept") }),
        "incorporate",
        false,
      ),
    ).toBe("acceptByMesa");
    expect(
      stateKey(
        incorporated("a", { position: byMesa("accept") }),
        "incorporate",
        false,
      ),
    ).toBe("incorporatedByMesa");
    expect(
      stateKey(amendment("a", { position: byMesa("reject") }), "vote", false),
    ).toBe("rejectByMesa");
    // The Mesa reads it: "La Mesa, en nombre de CEUM, ...".
    expect(
      stateKey(amendment("a", { position: byMesa("transact") }), "vote", true),
    ).toBe("transactByMesaFor");
    expect(
      stateKey(
        incorporated("a", { position: byMesa("accept") }),
        "incorporate",
        true,
      ),
    ).toBe("incorporatedByMesaFor");
  });

  it("names nobody while the answer is pending or hidden", () => {
    const pendingByMesa = amendment("a", {
      position: {
        position: "pending",
        comment: null,
        recordedBy: "mesa",
        updatedAt: "2026-11-02T10:00:00.000Z",
      },
    });
    expect(stateKey(pendingByMesa, "vote", false)).toBe("pending");
    expect(stateKey(pendingByMesa, "vote", true)).toBe("pendingFor");
    expect(stateKey(amendment("a", { position: null }), "vote", true)).toBe(
      "pendingFor",
    );
  });
});

describe("answeredByMesa", () => {
  it("is true only for an answer the Mesa recorded", () => {
    expect(answeredByMesa(amendment("a", { position: byMesa("reject") }))).toBe(
      true,
    );
    expect(
      answeredByMesa(amendment("a", { position: answered("reject") })),
    ).toBe(false);
    expect(answeredByMesa(amendment("a", { position: null }))).toBe(false);
    expect(
      answeredByMesa(
        amendment("a", {
          position: {
            position: "pending",
            comment: null,
            recordedBy: "mesa",
            updatedAt: "",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("presenterAnswerKey", () => {
  it("reads what the main presenter answered", () => {
    expect(presenterAnswerKey(amendment("a"))).toBe("pending");
    expect(
      presenterAnswerKey(amendment("a", { position: answered("accept") })),
    ).toBe("answered.accept");
    expect(
      presenterAnswerKey(amendment("a", { position: answered("transact") })),
    ).toBe("answered.transact");
    expect(presenterAnswerKey(incorporated("a"))).toBe("answered.incorporated");
  });

  it("says when the Mesa answered on its behalf", () => {
    expect(
      presenterAnswerKey(amendment("a", { position: byMesa("reject") })),
    ).toBe("answeredByMesa.reject");
    expect(
      presenterAnswerKey(incorporated("a", { position: byMesa("accept") })),
    ).toBe("answeredByMesa.incorporated");
  });

  it("does not pass a hidden answer for an unanswered one", () => {
    expect(presenterAnswerKey(amendment("a", { position: null }))).toBe(
      "hidden",
    );
    // Incorporated: its status already tells the answer, without who gave it.
    expect(presenterAnswerKey(incorporated("a", { position: null }))).toBe(
      "answered.incorporated",
    );
  });
});

describe("proponentReviewItems", () => {
  const list = [
    amendment("late", { positionKey: 30 }),
    amendment("first", { positionKey: 10, position: answered("accept") }),
    transactional("2", { positionKey: 20 }),
    incorporated("in", { positionKey: 25 }),
    amendment("hidden", {
      positionKey: 5,
      reviewState: "pending_validation",
      validatedAt: null,
      admission: "pending",
    }),
    privateOne("private", { positionKey: 6 }),
    amendment("waiting", { positionKey: 7, late: true, admission: "pending" }),
    transactional("3", {
      positionKey: 1,
      acceptances: [party(CEUM)],
    }),
  ];

  it("lists nothing once the document is voted", () => {
    for (const rule of ["vote", "incorporate"] as const) {
      expect(proponentReviewItems(list, rule, { finalVoted: true })).toEqual(
        [],
      );
    }
  });

  it("lists what the actor answers in text order", () => {
    expect(
      proponentReviewItems(list, "incorporate").map((item) => [
        item.id,
        item.answered,
      ]),
    ).toEqual([
      ["first", true],
      ["2", false],
      ["in", true],
      ["late", false],
    ]);
    // Under "vote" the incorporated one is settled; the private one waits
    // for publication under either rule.
    expect(
      proponentReviewItems(list, "vote").map((item) => [
        item.id,
        item.answered,
      ]),
    ).toEqual([
      ["first", true],
      ["2", false],
      ["late", false],
    ]);
  });

  it("gives a co-presenter the answers without the right to answer", () => {
    const readOnly = list.map((item) => ({
      ...item,
      can: { ...item.can, position: false },
    }));
    expect(proponentReviewItems(readOnly, "incorporate")).toEqual([]);
    expect(
      presenterAnswerItems(readOnly, "incorporate").map((item) => item.id),
    ).toEqual(["first", "2", "in", "late"]);
  });

  it("counts the progress over the amendments to answer", () => {
    const items = proponentReviewItems(list, "incorporate");
    expect(proponentReviewProgress(items)).toEqual({ answered: 2, total: 4 });
    expect(positionCounts(items)).toEqual({
      pending: 2,
      accept: 2,
      reject: 0,
      transact: 0,
    });
  });

  it("numbers each step in the whole review", () => {
    const items = proponentReviewItems(list, "incorporate");
    expect(stepCounter(items, "2")).toEqual({ current: 2, total: 4 });
    expect(stepCounter(items, "late")).toEqual({ current: 4, total: 4 });
    expect(stepCounter(items, "hidden")).toBeNull();
    expect(stepCounter(items, null)).toBeNull();
  });

  it("counts what is still on its way to the presenter", () => {
    expect(positionWaitCounts(list, "incorporate")).toEqual({
      authors: 1,
      validation: 1,
      admission: 1,
      publication: 1,
    });
    expect(positionWaitCounts(list, "vote")).toEqual({
      authors: 1,
      validation: 1,
      admission: 1,
      publication: 1,
    });
  });
});

describe("presenterAnswerItems", () => {
  it("keeps the main presenter's answers once the amendments are settled", () => {
    const items = presenterAnswerItems(
      [
        // Answered "reject", then voted down by the assembly.
        amendment("voted", {
          positionKey: 1,
          status: "rejected",
          decidedAt: "2026-11-03T10:00:00.000Z",
          position: answered("reject"),
        }),
        amendment("approved", {
          positionKey: 2,
          status: "approved",
          approvalMethod: "vote",
          position: answered("accept"),
        }),
        amendment("withdrawn", {
          positionKey: 3,
          status: "withdrawn",
          position: answered("transact"),
        }),
        // Settled without an answer: nothing the presenter decided.
        amendment("lapsed", { positionKey: 4, status: "lapsed" }),
        // Replaced by a transactional, or never admitted: left out.
        amendment("replaced", {
          positionKey: 5,
          status: "transacted",
          position: answered("transact"),
        }),
        amendment("inadmissible", {
          positionKey: 6,
          status: "inadmissible",
          admission: "inadmissible",
          position: answered("reject"),
        }),
        amendment("draft", { positionKey: 7, status: "draft" }),
        amendment("open", { positionKey: 8 }),
      ],
      "vote",
    );
    expect(items.map((item) => item.id)).toEqual([
      "voted",
      "approved",
      "withdrawn",
      "open",
    ]);
  });

  it("keeps only the answers once the document is voted or closed", () => {
    expect(
      presenterAnswerItems(
        [
          amendment("a", { positionKey: 1, position: answered("accept") }),
          amendment("b", { positionKey: 2 }),
          incorporated("c", { positionKey: 3, position: null }),
        ],
        "incorporate",
        { answeredOnly: true },
      ).map((item) => item.id),
    ).toEqual(["a", "c"]);
  });

  it("does not list what the presenter cannot answer yet", () => {
    expect(
      presenterAnswerItems(
        [
          amendment("late", { late: true, admission: "pending" }),
          transactional("t", {
            acceptances: [party(CEUM, "accepted"), party(CEA)],
          }),
          privateOne("private"),
        ],
        "vote",
      ),
    ).toEqual([]);
  });

  it("lists an answer the Mesa recorded like any other", () => {
    const items = presenterAnswerItems(
      [amendment("a", { position: byMesa("accept") })],
      "vote",
    );
    expect(items.map((item) => [item.id, item.answered])).toEqual([
      ["a", true],
    ]);
    expect(presenterAnswerKey(items[0]!.amendment)).toBe(
      "answeredByMesa.accept",
    );
  });

  it("shows a transactional's answer in place of the amendments it replaced", () => {
    const list = [
      amendment("s1", {
        positionKey: 1,
        status: "transacted",
        position: answered("transact"),
      }),
      amendment("s2", { positionKey: 2, status: "transacted" }),
      transactional("1", { positionKey: 3, position: answered("accept") }),
    ];
    expect(
      presenterAnswerItems(list, "vote").map((item) => [
        item.id,
        item.answered,
      ]),
    ).toEqual([["1", true]]);
    // Accepted under "incorporate": approved at once, and still listed once
    // the document is voted, its answer hidden or not.
    expect(
      presenterAnswerItems(
        [incorporated("t", { kind: "transactional", position: null })],
        "incorporate",
        { answeredOnly: true },
      ).map((item) => item.id),
    ).toEqual(["t"]);
  });
});

describe("amendmentOutcome", () => {
  it("says how a decided amendment ended", () => {
    expect(amendmentOutcome(amendment("a"))).toBeNull();
    expect(amendmentOutcome(incorporated("a"))).toBeNull();
    expect(
      amendmentOutcome(
        amendment("a", { status: "approved", approvalMethod: "vote" }),
      ),
    ).toBe("approved");
    expect(
      amendmentOutcome(
        amendment("a", { status: "approved", approvalMethod: "assent" }),
      ),
    ).toBe("approved");
    expect(
      amendmentOutcome(
        amendment("a", { status: "approved", approvalMethod: "formal" }),
      ),
    ).toBe("approvedFormal");
    expect(amendmentOutcome(amendment("a", { status: "rejected" }))).toBe(
      "rejected",
    );
    expect(amendmentOutcome(amendment("a", { status: "withdrawn" }))).toBe(
      "withdrawn",
    );
    expect(amendmentOutcome(amendment("a", { status: "lapsed" }))).toBe(
      "lapsed",
    );
    expect(amendmentOutcome(amendment("a", { status: "transacted" }))).toBe(
      null,
    );
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
        // Replaced by a transactional: the transactional's answer counts.
        amendment("f", {
          status: "transacted",
          position: answered("transact"),
        }),
        transactional("t", {
          status: "approved",
          position: answered("accept"),
        }),
      ]),
    ).toEqual({ pending: 0, accept: 2, reject: 2, transact: 0 });
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
    "vote",
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

describe("answerStatus", () => {
  it("reads the answer, and says when it is already in the text", () => {
    expect(answerStatus(amendment("a"))).toBe("pending");
    expect(answerStatus(amendment("a", { position: null }))).toBe("pending");
    expect(
      answerStatus(amendment("a", { position: answered("transact") })),
    ).toBe("transact");
    expect(answerStatus(amendment("a", { position: answered("accept") }))).toBe(
      "accept",
    );
    expect(answerStatus(incorporated("a"))).toBe("incorporated");
  });
});

describe("visibleAnswerProgress", () => {
  it("leaves answers hidden from the viewer out of the count", () => {
    const items = presenterAnswerItems(
      [
        amendment("a", { positionKey: 1, position: answered("accept") }),
        amendment("b", { positionKey: 2 }),
        amendment("c", { positionKey: 3, position: null }),
      ],
      "vote",
    );
    expect(items).toHaveLength(3);
    expect(visibleAnswerProgress(items)).toEqual({ answered: 1, total: 2 });
  });
});

describe("emptyReviewReason", () => {
  it("says some are on their way when anything waits", () => {
    expect(
      emptyReviewReason(
        [
          amendment("a", { status: "rejected" }),
          amendment("b", { late: true, admission: "pending" }),
        ],
        "vote",
      ),
    ).toBe("waiting");
    // Validated and private: on its way to publication, under either rule.
    expect(emptyReviewReason([privateOne("a")], "incorporate")).toBe("waiting");
    expect(emptyReviewReason([privateOne("a")], "vote")).toBe("waiting");
  });

  it("says everything is decided when nothing presented waits", () => {
    expect(
      emptyReviewReason(
        [
          amendment("a", { status: "rejected" }),
          amendment("b", { status: "transacted" }),
          transactional("t", { status: "approved", approvalMethod: "vote" }),
          amendment("d", { status: "draft" }),
        ],
        "vote",
      ),
    ).toBe("allDecided");
  });

  it("says nothing was presented when there are only drafts or nothing", () => {
    expect(emptyReviewReason([], "vote")).toBe("none");
    expect(
      emptyReviewReason(
        [amendment("d", { status: "draft", reviewState: null })],
        "incorporate",
      ),
    ).toBe("none");
  });
});

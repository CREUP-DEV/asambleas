import { describe, expect, it, vi } from "vitest";

// Only the pure helpers are tested here: the loader needs the database.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./amendments", () => ({
  canSeeLoadedAmendment: vi.fn(),
  findAmendmentsByIds: vi.fn(),
}));
vi.mock("./presenters", () => ({
  coPresentedBy: vi.fn(),
  withCoProponentIds: vi.fn(),
}));
vi.mock("./visibility", () => ({
  canSeeDocument: vi.fn(),
  canSeePositions: vi.fn(),
  isDocumentPresenter: vi.fn(),
}));

const {
  NEWS_DOCUMENT_TYPES,
  NEWS_OUTCOME_TYPES,
  isAutomaticChange,
  isAutomaticClosure,
  isAutomaticRestore,
  isNewsEvent,
  isOthersDecision,
  newsByMemberId,
  newsValue,
} = await import("./news");

describe("news types", () => {
  it("covers what the home page puts into words, documents included", () => {
    expect(NEWS_DOCUMENT_TYPES).toEqual([
      "document_published",
      "document_correction_requested",
      "document_voted",
      "document_status_changed",
    ]);
    expect(NEWS_OUTCOME_TYPES).toContain("amendment_transacted");
    expect(NEWS_OUTCOME_TYPES).not.toContain("position_changed");
  });
});

describe("newsValue", () => {
  it("says the decision in short", () => {
    expect(newsValue("position_changed", { position: "accept" })).toBe(
      "accept",
    );
    expect(newsValue("acceptance_recorded", { decision: "rejected" })).toBe(
      "rejected",
    );
    expect(newsValue("amendment_validated", { admission: "pending" })).toBe(
      "pending",
    );
    expect(newsValue("amendment_approved", { method: "proponent" })).toBe(
      "proponent",
    );
  });

  it("names the transactional that replaced the amendment", () => {
    expect(
      newsValue("amendment_transacted", { transactionalId: "t", code: "T2" }),
    ).toBe("T2");
    expect(
      newsValue("amendment_lapsed", {
        reason: "sources_transacted",
        transactionalId: "t",
        code: "T2",
      }),
    ).toBe("T2");
    // The Mesa lapsing an amendment names nobody.
    expect(newsValue("amendment_lapsed", { by: "moderator" })).toBeNull();
  });

  it("names the amendment whose fate closed a transactional", () => {
    expect(
      newsValue("amendment_withdrawn", {
        by: "sources_closed",
        sourceId: "a",
        sourceCode: "CEUM 4",
        sourceStatus: "approved",
      }),
    ).toBe("CEUM 4");
    expect(newsValue("amendment_withdrawn", { by: "author" })).toBeNull();
  });

  it("says how a document was settled", () => {
    expect(newsValue("document_voted", { result: "rejected" })).toBe(
      "rejected",
    );
    expect(
      newsValue("document_status_changed", {
        from: "published",
        to: "postponed",
      }),
    ).toBe("postponed");
  });

  it("says the kind an amendment was reclassified to", () => {
    expect(
      newsValue("amendment_reclassified", { from: "partial", to: "formal" }),
    ).toBe("formal");
    expect(
      newsValue("amendment_reclassified", { from: "formal", to: "partial" }),
    ).toBe("partial");
    expect(NEWS_OUTCOME_TYPES).toContain("amendment_reclassified");
  });

  it("says the new code when the Secretaría corrects who presents it", () => {
    const authors = { authorMemberIds: ["a"], mainAuthorId: "a" };
    expect(
      newsValue("amendment_authors_changed", {
        from: authors,
        to: { authorMemberIds: ["b"], mainAuthorId: "b" },
        code: "CEUM 2",
        previousCode: "CEA 1",
      }),
    ).toBe("CEUM 2");
    expect(
      newsValue("amendment_authors_changed", { from: authors, to: authors }),
    ).toBeNull();
    expect(NEWS_OUTCOME_TYPES).toContain("amendment_authors_changed");
  });

  it("leaves it out when the type says it all", () => {
    expect(newsValue("amendment_published", {})).toBeNull();
    expect(newsValue("position_changed", {})).toBeNull();
    expect(
      newsValue("document_published", { reference: "RES 1/2026" }),
    ).toBeNull();
    expect(
      newsValue("document_correction_requested", { note: "x" }),
    ).toBeNull();
  });
});

describe("newsByMemberId", () => {
  it("names the party that answered a transactional, also through the Mesa", () => {
    expect(
      newsByMemberId("acceptance_recorded", { memberId: "party" }, "mesa"),
    ).toBe("party");
  });

  it("credits the main presenter's answer to it, also through the Mesa", () => {
    expect(
      newsByMemberId(
        "position_changed",
        { memberId: "presenter", by: "moderator" },
        "mesa",
      ),
    ).toBe("presenter");
    expect(
      newsByMemberId(
        "position_changed",
        { memberId: "presenter", by: "proponent" },
        "presenter",
      ),
    ).toBe("presenter");
  });

  it("credits the document's main presenter for an older answer the Mesa recorded", () => {
    expect(
      newsByMemberId("position_changed", { by: "moderator" }, "mesa"),
    ).toBeNull();
    expect(
      newsByMemberId(
        "position_changed",
        { by: "moderator" },
        "mesa",
        "presenter",
      ),
    ).toBe("presenter");
  });

  it("credits the main presenter for what its acceptance incorporated", () => {
    expect(
      newsByMemberId(
        "amendment_approved",
        { method: "proponent", byPosition: true, memberId: "presenter" },
        "mesa",
        "other",
      ),
    ).toBe("presenter");
    // Recorded before the event named it, or by a change of rule.
    expect(
      newsByMemberId(
        "amendment_approved",
        { method: "proponent", reason: "rule_changed" },
        "secretaria",
        "presenter",
      ),
    ).toBe("presenter");
    expect(
      newsByMemberId(
        "amendment_reopened",
        { previousStatus: "approved", reason: "position_changed" },
        "mesa",
        "presenter",
      ),
    ).toBe("presenter");
    // Approved by the Mesa or the assembly: whoever recorded it.
    expect(
      newsByMemberId(
        "amendment_approved",
        { method: "vote" },
        "mesa",
        "presenter",
      ),
    ).toBe("mesa");
    expect(
      newsByMemberId(
        "amendment_reopened",
        { previousStatus: "approved", reason: "rule_changed" },
        "secretaria",
        "presenter",
      ),
    ).toBe("secretaria");
  });

  it("names nobody for a transactional that closed by itself", () => {
    // Whoever settled what it grouped did not decide about it.
    expect(
      newsByMemberId(
        "amendment_withdrawn",
        {
          by: "sources_closed",
          sourceId: "a",
          sourceCode: "CEUM 4",
          sourceStatus: "approved",
        },
        "mesa",
        "presenter",
      ),
    ).toBeNull();
    expect(
      newsByMemberId(
        "amendment_lapsed",
        { reason: "sources_transacted", transactionalId: "t", code: "T2" },
        "presenter",
        "presenter",
      ),
    ).toBeNull();
    // Withdrawn or lapsed by somebody: that somebody.
    expect(newsByMemberId("amendment_withdrawn", { by: "author" }, "a")).toBe(
      "a",
    );
    expect(
      newsByMemberId("amendment_lapsed", { by: "moderator" }, "mesa"),
    ).toBe("mesa");
  });

  it("names the member the actor acted for otherwise", () => {
    expect(newsByMemberId("position_changed", {}, "presenter")).toBe(
      "presenter",
    );
    expect(newsByMemberId("amendment_validated", {}, null)).toBeNull();
    expect(newsByMemberId("document_published", {}, "secretaria")).toBe(
      "secretaria",
    );
  });
});

describe("isOthersDecision", () => {
  const me = { userId: "me", memberId: "m" };
  const event = (
    overrides: Partial<Parameters<typeof isOthersDecision>[0]> = {},
  ) => ({
    type: "position_changed",
    payload: {},
    actorUserId: "someone",
    actorMemberId: "presenter",
    ...overrides,
  });

  it("keeps what someone else decided", () => {
    expect(isOthersDecision(event(), me)).toBe(true);
    expect(isOthersDecision(event({ actorMemberId: null }), me)).toBe(true);
  });

  it("leaves out the member's own decisions", () => {
    expect(isOthersDecision(event({ actorUserId: "me" }), me)).toBe(false);
    expect(isOthersDecision(event({ actorMemberId: "m" }), me)).toBe(false);
    expect(
      isOthersDecision(
        event({
          type: "acceptance_recorded",
          payload: { memberId: "m" },
          actorMemberId: "mesa",
        }),
        me,
      ),
    ).toBe(false);
    // The Mesa answering for the member as main presenter.
    expect(
      isOthersDecision(
        event({ payload: { memberId: "m", by: "moderator" } }),
        me,
      ),
    ).toBe(false);
  });

  it("keeps what an Admin did while acting as this account", () => {
    const done = event({
      actorUserId: "me",
      actorMemberId: "m",
      impersonationId: "imp1",
    });
    expect(isOthersDecision(done, me)).toBe(true);
    expect(isOthersDecision({ ...done, impersonationId: null }, me)).toBe(
      false,
    );
    // Done as another account of the member, it is still the member's own.
    expect(
      isOthersDecision(
        { ...done, actorUserId: "colleague", impersonationId: "imp1" },
        me,
      ),
    ).toBe(false);
  });

  it("leaves out what the member's own acceptance incorporated", () => {
    const incorporated = event({
      type: "amendment_approved",
      payload: { method: "proponent", byPosition: true },
      actorMemberId: "mesa",
    });
    expect(isOthersDecision(incorporated, me, "m")).toBe(false);
    expect(isOthersDecision(incorporated, me, "presenter")).toBe(true);
  });

  it("keeps a transactional that closed by itself, also when the user's own act closed it", () => {
    const closed = event({
      type: "amendment_withdrawn",
      payload: {
        by: "sources_closed",
        sourceId: "a",
        sourceCode: "CEUM 4",
        sourceStatus: "withdrawn",
      },
      actorUserId: "me",
      actorMemberId: "m",
    });
    expect(isOthersDecision(closed, me)).toBe(true);
    expect(
      isOthersDecision(
        event({
          type: "amendment_lapsed",
          payload: {
            reason: "sources_transacted",
            transactionalId: "t",
            code: "T2",
          },
          actorUserId: "me",
          actorMemberId: "m",
        }),
        me,
        "m",
      ),
    ).toBe(true);
    // Withdrawing its own amendment is still its own decision.
    expect(
      isOthersDecision(
        event({
          type: "amendment_withdrawn",
          payload: { by: "author" },
          actorUserId: "me",
          actorMemberId: "m",
        }),
        me,
      ),
    ).toBe(false);
  });

  it("keeps an answer the Mesa recorded for another main presenter", () => {
    expect(
      isOthersDecision(
        event({
          payload: { memberId: "presenter", by: "moderator" },
          actorMemberId: "m",
        }),
        me,
      ),
    ).toBe(true);
  });
});

describe("isNewsEvent", () => {
  const none = {
    presented: false,
    coPresented: false,
    authored: false,
    overOwn: false,
  };
  const onAmendment = (
    type: string,
    payload: Record<string, unknown> = {},
  ) => ({
    entityType: "amendment",
    type,
    payload,
  });

  it("tells co-presenters and authors the main presenter's answer", () => {
    const answer = onAmendment("position_changed", { position: "accept" });
    expect(isNewsEvent(answer, { ...none, coPresented: true })).toBe(true);
    expect(isNewsEvent(answer, { ...none, authored: true })).toBe(true);
    expect(isNewsEvent(answer, { ...none, overOwn: true })).toBe(false);
    expect(isNewsEvent(answer, none)).toBe(false);
  });

  it("tells authors what was settled about their amendment", () => {
    for (const type of NEWS_OUTCOME_TYPES) {
      expect(isNewsEvent(onAmendment(type), { ...none, authored: true })).toBe(
        true,
      );
    }
    expect(
      isNewsEvent(onAmendment("amendment_created"), {
        ...none,
        authored: true,
      }),
    ).toBe(false);
  });

  it("leaves out the withdrawal a main author's rejection caused", () => {
    expect(
      isNewsEvent(
        onAmendment("amendment_withdrawn", {
          by: "author_rejection",
          memberId: "x",
        }),
        { ...none, authored: true, overOwn: true },
      ),
    ).toBe(false);
    expect(
      isNewsEvent(
        onAmendment("acceptance_recorded", { decision: "rejected" }),
        {
          ...none,
          overOwn: true,
        },
      ),
    ).toBe(true);
  });

  it("tells the parties of a transactional that it closed by itself", () => {
    const party = { ...none, overOwn: true };
    expect(
      isNewsEvent(
        onAmendment("amendment_withdrawn", {
          by: "sources_closed",
          sourceId: "a",
          sourceCode: "CEUM 4",
          sourceStatus: "rejected",
        }),
        party,
      ),
    ).toBe(true);
    expect(
      isNewsEvent(
        onAmendment("amendment_lapsed", {
          reason: "sources_transacted",
          transactionalId: "t",
          code: "T2",
        }),
        party,
      ),
    ).toBe(true);
    // Its own authors withdrawing it, or the Mesa, is theirs to tell.
    expect(
      isNewsEvent(onAmendment("amendment_withdrawn", { by: "author" }), party),
    ).toBe(false);
    expect(
      isNewsEvent(onAmendment("amendment_lapsed", { by: "moderator" }), party),
    ).toBe(false);
    expect(isNewsEvent(onAmendment("amendment_approved"), party)).toBe(false);
  });

  it("tells presenters what was settled about their document", () => {
    const published = {
      entityType: "document",
      type: "document_published",
      payload: {},
    };
    expect(isNewsEvent(published, { ...none, presented: true })).toBe(true);
    expect(isNewsEvent(published, { ...none, authored: true })).toBe(false);
    expect(
      isNewsEvent(
        { ...published, type: "document_updated" },
        { ...none, presented: true },
      ),
    ).toBe(false);
  });
});

describe("isAutomaticClosure", () => {
  it("tells a transactional closed by itself from one somebody closed", () => {
    expect(
      isAutomaticClosure("amendment_withdrawn", { by: "sources_closed" }),
    ).toBe(true);
    expect(
      isAutomaticClosure("amendment_lapsed", { reason: "sources_transacted" }),
    ).toBe(true);
    expect(isAutomaticClosure("amendment_withdrawn", { by: "moderator" })).toBe(
      false,
    );
    expect(
      isAutomaticClosure("amendment_withdrawn", { by: "author_rejection" }),
    ).toBe(false);
    expect(isAutomaticClosure("amendment_lapsed", { by: "moderator" })).toBe(
      false,
    );
  });
});

describe("isAutomaticRestore", () => {
  const restored = { reason: "source_reopened", sourceCode: "CEUM 4" };

  it("tells a transactional back by itself from one somebody reopened", () => {
    expect(isAutomaticRestore("amendment_reopened", restored)).toBe(true);
    expect(
      isAutomaticRestore("amendment_reopened", { reason: "position_changed" }),
    ).toBe(false);
    expect(isAutomaticRestore("amendment_reopened", {})).toBe(false);
    expect(isAutomaticChange("amendment_reopened", restored)).toBe(true);
    expect(
      isAutomaticChange("amendment_withdrawn", { by: "sources_closed" }),
    ).toBe(true);
  });

  it("names the amendment reopened and nobody as who decided", () => {
    expect(newsValue("amendment_reopened", restored)).toBe("CEUM 4");
    expect(
      newsValue("amendment_reopened", { reason: "position_changed" }),
    ).toBeNull();
    expect(newsByMemberId("amendment_reopened", restored, "m1", "m2")).toBe(
      null,
    );
  });

  it("reaches the parties and also the user whose act brought it back", () => {
    const event = {
      entityType: "amendment",
      type: "amendment_reopened",
      payload: restored,
    };
    const none = {
      presented: false,
      coPresented: false,
      authored: false,
      overOwn: false,
    };
    expect(isNewsEvent(event, { ...none, overOwn: true })).toBe(true);
    expect(
      isNewsEvent(
        { ...event, payload: { reason: "position_changed" } },
        { ...none, overOwn: true },
      ),
    ).toBe(false);
    expect(
      isOthersDecision(
        { ...event, actorUserId: "u1", actorMemberId: "m1" },
        { userId: "u1", memberId: "m1" },
      ),
    ).toBe(true);
  });
});

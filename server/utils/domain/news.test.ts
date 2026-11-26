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
  seesUnpublishedPositions: vi.fn(),
}));

const {
  NEWS_DOCUMENT_TYPES,
  NEWS_GROUP_CODES,
  NEWS_OUTCOME_TYPES,
  NEWS_PRESENTER_CANDIDATES,
  NEWS_PRESENTER_TYPES,
  NEWS_RUN_MS,
  awaitsMainPresenterAnswer,
  groupNewsRuns,
  isAutomaticAnswer,
  isAutomaticChange,
  isAutomaticClosure,
  isAutomaticRestore,
  isNewsEvent,
  isOthersDecision,
  isPresenterCandidate,
  isPresenterNews,
  isPresentersOwnTransactional,
  isRepeatedArrival,
  mergeNewsRows,
  newsByMemberId,
  newsRunKey,
  newsValue,
  newsVisibleAt,
  presenterClosureStands,
  presenterNewsState,
  presenterRowsOnce,
  NEWS_LIMIT,
  NEWS_MESA_CANDIDATES,
  completesAcceptance,
  isMesaOthersAct,
  mesaNewsKind,
  mesaNewsScope,
  mesaNewsStands,
  mesaRowRepeatsMember,
  mesaRowsOnce,
  newsRowRole,
} = await import("./news");
const { PERMISSION_KEYS } = await import("~~/shared/constants/permissions");

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
    // Not admitted by the Secretaría while reviewing it, or by the Mesa.
    expect(
      newsValue("amendment_inadmissible", {
        method: "secretaria",
        onReview: true,
      }),
    ).toBe("review");
    expect(
      newsValue("amendment_inadmissible", { method: "secretaria" }),
    ).toBeNull();
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
    // Lapsed by the Mesa after it replaced what it groups: never read as
    // the code of another transactional.
    expect(
      newsValue("amendment_lapsed", {
        by: "moderator",
        replacedSources: true,
        replacedSourceIds: ["a"],
      }),
    ).toBe("replaced");
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
    // Withdrawn after it replaced what it groups.
    expect(
      newsValue("amendment_withdrawn", {
        by: "moderator",
        replacedSources: true,
      }),
    ).toBe("replaced");
  });

  it("says how a document was settled", () => {
    expect(newsValue("document_voted", { result: "rejected" })).toBe(
      "rejected",
    );
    // Approved leaving passages pending conciliation (2026-11-21).
    expect(
      newsValue("document_voted", {
        result: "approved",
        pendingPassageKeys: ["A,B|b2"],
      }),
    ).toBe("approved_pending");
    expect(
      newsValue("document_voted", {
        result: "approved",
        pendingPassageKeys: [],
      }),
    ).toBe("approved");
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

  it("credits the co-presenter who answered, and tells the main presenter", () => {
    const answer = {
      type: "position_changed",
      payload: { memberId: "co", by: "proponent", position: "reject" },
      actorUserId: "co-user",
      actorMemberId: "co",
    };
    expect(newsByMemberId(answer.type, answer.payload, "co", "main")).toBe(
      "co",
    );
    expect(
      isOthersDecision(
        answer,
        { userId: "main-user", memberId: "main" },
        "main",
      ),
    ).toBe(true);
    expect(
      isOthersDecision(answer, { userId: "other", memberId: "co" }, "main"),
    ).toBe(false);
    // What its new answer took out of the text names it too.
    expect(
      newsByMemberId(
        "amendment_reopened",
        {
          previousStatus: "approved",
          reason: "position_changed",
          memberId: "co",
        },
        "co",
        "main",
      ),
    ).toBe("co");
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
    answered: false,
    authored: false,
    overOwn: false,
    ownSourceIds: [] as string[],
  };
  const onAmendment = (
    type: string,
    payload: Record<string, unknown> = {},
  ) => ({
    entityType: "amendment",
    type,
    payload,
  });

  it("tells the presenters and authors a presenter's answer", () => {
    const answer = onAmendment("position_changed", { position: "accept" });
    expect(isNewsEvent(answer, { ...none, answered: true })).toBe(true);
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

  it("tells the parties of a transactional in force that it was withdrawn", () => {
    const party = { ...none, overOwn: true, ownSourceIds: ["a"] };
    // The Mesa withdraws one that already replaced their amendments: they
    // stay replaced.
    const replacing = onAmendment("amendment_withdrawn", {
      by: "moderator",
      replacedSources: true,
      replacedSourceIds: ["a", "b"],
    });
    expect(isNewsEvent(replacing, party)).toBe(true);
    // Its late source still waiting for admission was not replaced: that
    // amendment is still open, so its author is not told it stays replaced.
    expect(isNewsEvent(replacing, { ...party, ownSourceIds: ["late"] })).toBe(
      false,
    );
    // Nor without the amendments it replaced named.
    expect(
      isNewsEvent(
        onAmendment("amendment_withdrawn", {
          by: "moderator",
          replacedSources: true,
        }),
        party,
      ),
    ).toBe(false);
    // One that replaced nothing (a late source pending, or presented under
    // the earlier rule) records no `replacedSources`.
    expect(
      isNewsEvent(
        onAmendment("amendment_withdrawn", { by: "moderator" }),
        party,
      ),
    ).toBe(false);
    // A pending one its proposer withdraws leaves their amendments open.
    expect(
      isNewsEvent(onAmendment("amendment_withdrawn", { by: "author" }), party),
    ).toBe(false);
    expect(
      isNewsEvent(
        onAmendment("amendment_withdrawn", { by: "moderator" }),
        party,
      ),
    ).toBe(false);
  });

  it("tells the parties of a transactional in force that it lapsed", () => {
    const party = { ...none, overOwn: true, ownSourceIds: ["a"] };
    // The Mesa lapses one that already replaced their amendments, from the
    // console or in bulk: they stay replaced.
    const replacing = onAmendment("amendment_lapsed", {
      by: "moderator",
      replacedSources: true,
      replacedSourceIds: ["a", "b"],
    });
    expect(isNewsEvent(replacing, party)).toBe(true);
    // Its late source still waiting for admission was not replaced.
    expect(isNewsEvent(replacing, { ...party, ownSourceIds: ["late"] })).toBe(
      false,
    );
    // Nor without the amendments it replaced named.
    expect(
      isNewsEvent(
        onAmendment("amendment_lapsed", {
          by: "moderator",
          replacedSources: true,
        }),
        party,
      ),
    ).toBe(false);
    // One that was not in force replaced nothing: a plain lapse.
    expect(
      isNewsEvent(onAmendment("amendment_lapsed", { by: "moderator" }), party),
    ).toBe(false);
    // Its own authors read the lapse as theirs.
    expect(isNewsEvent(replacing, { ...none, authored: true })).toBe(true);
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
      answered: false,
      authored: false,
      overOwn: false,
      ownSourceIds: [] as string[],
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

describe("automatic answer to formal amendments", () => {
  const accepted = { position: "accept", by: "auto", memberId: "presenter" };
  const approved = {
    method: "proponent",
    byPosition: true,
    memberId: "presenter",
    reason: "formal",
  };
  const reopened = {
    previousStatus: "approved",
    reason: "position_changed",
    by: "auto",
  };

  it("tells it apart from the main presenter's answers", () => {
    expect(isAutomaticAnswer("position_changed", accepted)).toBe(true);
    expect(isAutomaticAnswer("amendment_approved", approved)).toBe(true);
    expect(isAutomaticAnswer("amendment_reopened", reopened)).toBe(true);
    expect(
      isAutomaticAnswer("position_changed", { ...accepted, by: "proponent" }),
    ).toBe(false);
    expect(
      isAutomaticAnswer("amendment_approved", {
        method: "proponent",
        reason: "rule_changed",
      }),
    ).toBe(false);
  });

  it("credits nobody, not the main presenter", () => {
    expect(
      newsByMemberId("position_changed", accepted, "secretaria", "presenter"),
    ).toBeNull();
    expect(
      newsByMemberId("amendment_approved", approved, "secretaria", "presenter"),
    ).toBeNull();
    expect(
      newsByMemberId("amendment_reopened", reopened, "secretaria", "presenter"),
    ).toBeNull();
  });

  it("is nobody's decision, so it reaches the main presenter's own member", () => {
    const me = { userId: "me", memberId: "presenter" };
    expect(
      isOthersDecision(
        {
          type: "position_changed",
          payload: accepted,
          actorUserId: "me",
          actorMemberId: "presenter",
        },
        me,
        "presenter",
      ),
    ).toBe(true);
  });
});

describe("presenters' news about new amendments", () => {
  const none = {
    presented: false,
    answered: false,
    authored: false,
    overOwn: false,
    ownSourceIds: [] as string[],
  };
  const presenter = { ...none, answered: true };
  const onAmendment = (
    type: string,
    payload: Record<string, unknown> = {},
  ) => ({ entityType: "amendment", type, payload });

  it("tells the presenters an amendment new to their document and its closure", () => {
    for (const type of NEWS_PRESENTER_TYPES) {
      expect(isNewsEvent(onAmendment(type), presenter), type).toBe(true);
      expect(isPresenterNews(onAmendment(type), presenter), type).toBe(true);
    }
    // Not what only its authors read.
    for (const type of [
      "amendment_correction_requested",
      "amendment_reclassified",
      "amendment_admitted",
      "amendment_approved",
    ]) {
      expect(isNewsEvent(onAmendment(type), presenter), type).toBe(false);
    }
    // A transactional closed because a main author rejected it: the
    // rejection says it, never the withdrawal.
    expect(
      isNewsEvent(
        onAmendment("amendment_withdrawn", { by: "author_rejection" }),
        presenter,
      ),
    ).toBe(false);
  });

  it("leaves the presenters' rows to the other rules on what the member wrote", () => {
    const published = onAmendment("amendment_published");
    expect(isPresenterNews(published, { ...presenter, authored: true })).toBe(
      false,
    );
    // A transactional over the member's own amendment that closed by itself
    // is the party's news, not the presenter's.
    const closed = onAmendment("amendment_withdrawn", {
      by: "sources_closed",
      sourceCode: "UGR1",
    });
    expect(
      isPresenterNews(closed, {
        ...presenter,
        overOwn: true,
        ownSourceIds: ["a"],
      }),
    ).toBe(false);
    // The Mesa's lapse of one that replaced nothing of the member's: the
    // presenter's.
    expect(
      isPresenterNews(onAmendment("amendment_lapsed", { by: "moderator" }), {
        ...presenter,
        overOwn: true,
        ownSourceIds: ["a"],
      }),
    ).toBe(true);
    // Document news are never a presenter's amendment row.
    expect(
      isPresenterNews(
        { entityType: "document", type: "amendment_published", payload: {} },
        presenter,
      ),
    ).toBe(false);
  });

  it("checks a validation against the amendment still unpublished", () => {
    const validatedAt = new Date("2026-11-04T10:00:00Z");
    const publishedAt = new Date("2026-11-05T10:00:00Z");
    expect(
      presenterNewsState(
        "amendment_validated",
        { publish: false },
        { validatedAt, publishedAt },
        validatedAt,
      ),
    ).toEqual({ status: "submitted", validatedAt, publishedAt: null });
    // Validated and published at once: no amendment_published follows.
    expect(
      presenterNewsState(
        "amendment_validated",
        { publish: true },
        { validatedAt, publishedAt: validatedAt },
        validatedAt,
      ),
    ).toEqual({ status: "submitted", validatedAt, publishedAt: validatedAt });
    expect(
      presenterNewsState(
        "amendment_published",
        {},
        { validatedAt, publishedAt },
        publishedAt,
      ),
    ).toEqual({ status: "submitted", validatedAt, publishedAt });
    // A closure: what the reader saw while it was open.
    expect(
      presenterNewsState(
        "amendment_lapsed",
        {},
        { validatedAt, publishedAt: null },
        publishedAt,
      ),
    ).toEqual({ status: "submitted", validatedAt, publishedAt: null });
  });

  it("reads only the arrival an amendment can have for the reader", () => {
    const validated = { type: "amendment_validated", payload: {} };
    const validatedPublished = {
      type: "amendment_validated",
      payload: { publish: true },
    };
    const published = { type: "amendment_published", payload: {} };
    const lapsed = { type: "amendment_lapsed", payload: {} };
    // Read validated (a transactional, an office of the CEA): told then,
    // so its publication is no arrival.
    expect(isPresenterCandidate(validated, true)).toBe(true);
    expect(isPresenterCandidate(validatedPublished, true)).toBe(true);
    expect(isPresenterCandidate(published, true)).toBe(false);
    // A plain presenter: told at publication, by either event.
    expect(isPresenterCandidate(validated, false)).toBe(false);
    expect(isPresenterCandidate(validatedPublished, false)).toBe(true);
    expect(isPresenterCandidate(published, false)).toBe(true);
    // Closures always; nothing outside the presenters' types.
    expect(isPresenterCandidate(lapsed, false)).toBe(true);
    expect(isPresenterCandidate(lapsed, true)).toBe(true);
    expect(
      isPresenterCandidate({ type: "position_changed", payload: {} }, true),
    ).toBe(false);
  });

  it("keeps the general rows when the reader's validations fill no room", () => {
    const at = (minutes: number) =>
      new Date(Date.UTC(2026, 10, 20, 10, 0) - minutes * 60 * 1000);
    // A plain presenter: 300 amendments validated and kept private for
    // later, newest first, and its own news older than all of them.
    const validations = Array.from(
      { length: NEWS_PRESENTER_CANDIDATES },
      (_, index) => ({
        id: `v${index}`,
        createdAt: at(index),
        type: "amendment_validated",
        payload: { publish: false },
      }),
    );
    const general = [
      {
        id: "answer",
        createdAt: at(NEWS_PRESENTER_CANDIDATES + 60),
        type: "position_changed",
        payload: {},
      },
    ];
    // Read as before, the room is full and its cut drops the member's own
    // news for rows it can never see.
    expect(
      mergeNewsRows(
        { rows: general, limit: 90 },
        { rows: validations, limit: NEWS_PRESENTER_CANDIDATES },
      ).map((row) => row.id),
    ).not.toContain("answer");
    // The query reads none of them, so nothing is cut.
    const presenters = validations.filter((row) =>
      isPresenterCandidate(row, false),
    );
    expect(presenters).toEqual([]);
    expect(
      mergeNewsRows(
        { rows: general, limit: 90 },
        { rows: presenters, limit: NEWS_PRESENTER_CANDIDATES },
      ).map((row) => row.id),
    ).toEqual(["answer"]);
  });

  it("does not tell again at publication what was told at validation", () => {
    const validatedAt = new Date("2026-10-01T10:00:00Z");
    const publishedAt = new Date("2026-11-02T10:00:00Z");
    const amendment = { validatedAt };
    // Only the publication loaded (the validation left the window).
    expect(
      isRepeatedArrival(
        "amendment_published",
        amendment,
        publishedAt,
        () => true,
      ),
    ).toBe(true);
    // A reader that could not read it validated is told now.
    expect(
      isRepeatedArrival(
        "amendment_published",
        amendment,
        publishedAt,
        () => false,
      ),
    ).toBe(false);
    // Validated at that very moment, never validated, or not a publication.
    expect(
      isRepeatedArrival(
        "amendment_published",
        { validatedAt: publishedAt },
        publishedAt,
        () => true,
      ),
    ).toBe(false);
    expect(
      isRepeatedArrival(
        "amendment_published",
        { validatedAt: null },
        publishedAt,
        () => true,
      ),
    ).toBe(false);
    expect(
      isRepeatedArrival(
        "amendment_validated",
        amendment,
        validatedAt,
        () => true,
      ),
    ).toBe(false);
  });

  it("leaves out a transactional one of the presenters proposed", () => {
    const document = {
      proponentMemberId: "main",
      coProponentMemberIds: ["co"],
    };
    const transactional = (proposerMemberId?: string) => ({
      kind: "transactional",
      meta: proposerMemberId ? { proposerMemberId } : {},
    });
    expect(isPresentersOwnTransactional(transactional("main"), document)).toBe(
      true,
    );
    expect(isPresentersOwnTransactional(transactional("co"), document)).toBe(
      true,
    );
    // Another member's, or the Mesa's on nobody's behalf: news.
    expect(isPresentersOwnTransactional(transactional("other"), document)).toBe(
      false,
    );
    expect(isPresentersOwnTransactional(transactional(), document)).toBe(false);
    expect(
      isPresentersOwnTransactional(
        { kind: "partial", meta: { proposerMemberId: "main" } },
        document,
      ),
    ).toBe(false);
  });

  it("tells each new amendment once, from the first event that showed it", () => {
    const row = (
      id: string,
      entityId: string,
      type: string,
      presenter = true,
    ) => ({ id, entityId, type, presenter });
    // Newest first: validated and published in one request, an older
    // validation of the same amendment, another amendment, an author's rows.
    const rows = [
      row("p1", "a", "amendment_published"),
      row("v1", "a", "amendment_validated"),
      row("p2", "b", "amendment_published"),
      row("l1", "a", "amendment_lapsed"),
      row("v0", "a", "amendment_validated"),
      row("own", "c", "amendment_published", false),
      row("own0", "c", "amendment_validated", false),
    ];
    expect(presenterRowsOnce(rows).map((item) => item.id)).toEqual([
      "p2",
      "l1",
      "v0",
      "own",
      "own0",
    ]);
  });

  it("tells a closure the Mesa undid and recorded again once", () => {
    const row = (id: string, entityId: string, type: string) => ({
      id,
      entityId,
      type,
      presenter: true,
    });
    // Lapsed, reopened (no presenter row) and lapsed again in one run.
    const rows = [
      row("l2", "a", "amendment_lapsed"),
      row("lb", "b", "amendment_lapsed"),
      row("l1", "a", "amendment_lapsed"),
      row("p", "a", "amendment_published"),
    ];
    expect(presenterRowsOnce(rows).map((item) => item.id)).toEqual([
      "l2",
      "lb",
      "p",
    ]);
    // One back in debate is no longer told as closed.
    expect(presenterClosureStands("amendment_lapsed", "lapsed")).toBe(true);
    expect(presenterClosureStands("amendment_lapsed", "submitted")).toBe(false);
    expect(presenterClosureStands("amendment_withdrawn", "withdrawn")).toBe(
      true,
    );
    expect(presenterClosureStands("amendment_transacted", "submitted")).toBe(
      false,
    );
    expect(presenterClosureStands("amendment_published", "lapsed")).toBe(true);
  });

  it("leads only the main presenter to the review, while the answer is due", () => {
    const open = {
      kind: "partial" as "partial" | "transactional",
      acceptances: [] as { role: "author"; decision: "pending" }[],
      status: "submitted" as "submitted" | "lapsed",
      admission: "admitted" as const,
      validatedAt: new Date("2026-11-04T10:00:00Z"),
      publishedAt: new Date("2026-11-04T10:00:00Z") as Date | null,
      approvalMethod: null,
      position: null as { position: "pending" | "accept" } | null,
    };
    const document = {
      proponentMemberId: "main",
      proponentKind: "asociado" as string | null,
      finalVoteId: null as string | null,
      acceptedAmendments: "vote" as const,
    };
    expect(awaitsMainPresenterAnswer(open, document, "main")).toBe(true);
    expect(
      awaitsMainPresenterAnswer(
        { ...open, position: { position: "pending" } },
        document,
        "main",
      ),
    ).toBe(true);
    // A co-presenter reads the answers, never gives them.
    expect(awaitsMainPresenterAnswer(open, document, "co")).toBe(false);
    // Answered, decided, or the document voted.
    expect(
      awaitsMainPresenterAnswer(
        { ...open, position: { position: "accept" } },
        document,
        "main",
      ),
    ).toBe(false);
    expect(
      awaitsMainPresenterAnswer(
        { ...open, status: "lapsed" as const },
        document,
        "main",
      ),
    ).toBe(false);
    expect(
      awaitsMainPresenterAnswer(
        open,
        { ...document, finalVoteId: "vote-1" },
        "main",
      ),
    ).toBe(false);
    // Validated, not published: only an office of the CEA answers it.
    const unpublished = { ...open, publishedAt: null };
    expect(awaitsMainPresenterAnswer(unpublished, document, "main")).toBe(
      false,
    );
    expect(
      awaitsMainPresenterAnswer(
        unpublished,
        { ...document, proponentKind: "executive" },
        "main",
      ),
    ).toBe(true);
    // A transactional still waiting for its main authors.
    expect(
      awaitsMainPresenterAnswer(
        {
          ...open,
          kind: "transactional",
          acceptances: [{ role: "author", decision: "pending" }],
        },
        document,
        "main",
      ),
    ).toBe(false);
  });

  it("groups a run of the same kind on one document", () => {
    const at = (minutes: number) =>
      new Date(Date.UTC(2026, 10, 4, 10, 0) - minutes * 60 * 1000);
    const row = (
      id: string,
      minutes: number,
      over: Partial<{
        type: string;
        payload: Record<string, unknown>;
        presenter: boolean;
        documentId: string;
        transactional: boolean;
      }> = {},
    ) => ({
      id,
      createdAt: at(minutes),
      type: "amendment_published",
      payload: {},
      presenter: true,
      documentId: "d1",
      transactional: false,
      ...over,
    });
    const transacted = (code: string) => ({
      type: "amendment_transacted",
      payload: { code },
    });
    const rows = [
      row("a", 0),
      // Validated where the reader reads it then: a new amendment too.
      row("b", 4, { type: "amendment_validated" }),
      row("other-doc", 5, { documentId: "d2" }),
      row("t", 6, { transactional: true }),
      row("own", 7, { presenter: false }),
      row("c", 9),
      row("d", 19),
      // More than NEWS_RUN_MS after "d": a new run.
      row("e", 19 + NEWS_RUN_MS / 60000 + 1),
      row("by-t1", 40, transacted("T1")),
      row("by-t1b", 41, transacted("T1")),
      row("by-t2", 42, transacted("T2")),
    ];
    expect(
      groupNewsRuns(rows, newsRunKey).map((group) =>
        group.map((item) => item.id),
      ),
    ).toEqual([
      ["a", "b", "c", "d"],
      ["other-doc"],
      ["t"],
      ["own"],
      ["e"],
      ["by-t1", "by-t1b"],
      ["by-t2"],
    ]);
    expect(NEWS_GROUP_CODES).toBe(3);
  });

  it("merges both queries, newest first, each event once", () => {
    const at = (iso: string) => new Date(iso);
    const general = [
      { id: "g2", createdAt: at("2026-11-04T10:00:00Z") },
      { id: "both", createdAt: at("2026-11-04T09:00:00Z") },
    ];
    const presenters = [
      { id: "p1", createdAt: at("2026-11-04T11:00:00Z") },
      { id: "both", createdAt: at("2026-11-04T09:00:00Z") },
      { id: "p0", createdAt: at("2026-11-04T09:00:00Z") },
    ];
    const merged = (generalLimit: number) =>
      mergeNewsRows(
        { rows: general, limit: generalLimit },
        { rows: presenters, limit: 10 },
      ).map((row) => row.id);
    expect(merged(10)).toEqual(["p1", "g2", "p0", "both"]);
    // The general query filled its room: what it left out before its oldest
    // row is not skipped silently, so nothing older is kept.
    const older = { id: "old", createdAt: at("2026-11-04T08:00:00Z") };
    presenters.push(older);
    expect(merged(10)).toContain("old");
    expect(merged(2)).toEqual(["p1", "g2", "p0", "both"]);
  });
});

describe("newsVisibleAt", () => {
  const answeredAt = new Date("2026-11-20T09:00:00.000Z");
  const answer = { type: "position_changed", createdAt: answeredAt };
  const reserved = {
    positionsPublishedAt: null,
    positionsDebateStartedAt: null,
  };

  it("is the publication when an author could only read the answer then", () => {
    const published = new Date("2026-11-25T10:00:00.000Z");
    expect(
      newsVisibleAt(
        answer,
        { ...reserved, positionsPublishedAt: published },
        false,
      ),
    ).toEqual(published);
    // The debate started first: the answers were public from then on.
    const debate = new Date("2026-11-24T10:00:00.000Z");
    expect(
      newsVisibleAt(
        answer,
        { positionsPublishedAt: published, positionsDebateStartedAt: debate },
        false,
      ),
    ).toEqual(debate);
  });

  it("is null when the answer was readable from the start", () => {
    const earlier = new Date("2026-11-19T10:00:00.000Z");
    // Public already when it was recorded.
    expect(
      newsVisibleAt(
        answer,
        { ...reserved, positionsPublishedAt: earlier },
        false,
      ),
    ).toBeNull();
    // A presenter, the Mesa or a reviewer reads it before publication.
    expect(
      newsVisibleAt(
        answer,
        { ...reserved, positionsPublishedAt: new Date("2026-11-25T10:00Z") },
        true,
      ),
    ).toBeNull();
    // Not public yet (the row is not shown then either), or not an answer.
    expect(newsVisibleAt(answer, reserved, false)).toBeNull();
    expect(
      newsVisibleAt(
        { type: "amendment_validated", createdAt: answeredAt },
        { ...reserved, positionsPublishedAt: new Date("2026-11-25T10:00Z") },
        false,
      ),
    ).toBeNull();
  });
});

describe("the Mesa's scope", () => {
  const keys =
    (...held: string[]) =>
    (key: string) =>
      held.includes(key);
  const mesa = { validated: true };
  const validating = { validated: false };
  const amendmentEvent = (type: string, payload: Record<string, unknown>) => ({
    entityType: "amendment",
    entityId: "am1",
    type,
    payload,
  });
  const emptyScope = {
    presented: false,
    answered: false,
    authored: false,
    overOwn: false,
    ownSourceIds: [],
  };
  const noMember = {
    answeredIds: new Set<string>(),
    authoredIds: new Set<string>(),
  };
  type Kind = "validated" | "ready" | "rejected" | "withdrawn" | null;

  it("reaches whoever moderates, and the validations only those who do not validate", () => {
    expect(mesaNewsScope({ can: keys() })).toBeNull();
    expect(
      mesaNewsScope({ can: keys(PERMISSION_KEYS.AMENDMENT_REVIEW) }),
    ).toBeNull();
    expect(
      mesaNewsScope({ can: keys(PERMISSION_KEYS.SESSION_MODERATE) }),
    ).toEqual({ validated: true });
    // The Secretaría and the Presidencia hold every key: «Validación» is
    // theirs, so no validations here.
    expect(
      mesaNewsScope({
        can: keys(
          PERMISSION_KEYS.SESSION_MODERATE,
          PERMISSION_KEYS.AMENDMENT_REVIEW,
        ),
      }),
    ).toEqual({ validated: false });
    // amendment:manage holds amendment:review.
    expect(
      mesaNewsScope({
        can: keys(
          PERMISSION_KEYS.SESSION_MODERATE,
          PERMISSION_KEYS.AMENDMENT_MANAGE,
        ),
      }),
    ).toEqual({ validated: false });
    // An Admin passes every `can`.
    expect(mesaNewsScope({ can: () => true })).toEqual({ validated: false });
  });

  it("tells validations, ready transactionals, rejections and authors' withdrawals", () => {
    // A late validation carries no `method`.
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_validated", { admission: "pending" }),
        mesa,
      ),
    ).toBe("validated");
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_validated", { method: "secretaria" }),
        mesa,
      ),
    ).toBe("validated");
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_validated", { method: "secretaria" }),
        validating,
      ),
    ).toBeNull();
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_withdrawn", { by: "author" }),
        mesa,
      ),
    ).toBe("withdrawn");
    expect(
      mesaNewsKind(
        amendmentEvent("acceptance_recorded", {
          memberId: "m2",
          decision: "rejected",
        }),
        validating,
      ),
    ).toBe("rejected");
    expect(
      mesaNewsKind(
        amendmentEvent("acceptance_recorded", {
          memberId: "m2",
          decision: "accepted",
        }),
        validating,
      ),
    ).toBe("ready");
    // Its proposer was the only party: straight to the Secretaría.
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_submitted", { admission: "pending" }),
        mesa,
      ),
    ).toBe("ready");
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_submitted", {
          admission: "pending",
          awaitsAuthors: true,
        }),
        mesa,
      ),
    ).toBeNull();
    expect(
      mesaNewsKind(
        amendmentEvent("transactional_revision_ready", { revisionId: "r" }),
        mesa,
      ),
    ).toBe("revision_ready");
    expect(
      mesaNewsKind(
        { entityType: "document", type: "document_published", payload: {} },
        mesa,
      ),
    ).toBeNull();
  });

  it("leaves out what the Mesa records from the console", () => {
    // Its own transactional, validated as it presents it.
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_validated", {
          publish: true,
          admission: "admitted",
          method: "mesa",
        }),
        mesa,
      ),
    ).toBeNull();
    // Presented by the Mesa: admitted at once, nothing to validate.
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_submitted", { admission: "admitted" }),
        mesa,
      ),
    ).toBeNull();
    for (const by of ["moderator", "author_rejection", "sources_closed"]) {
      expect(
        mesaNewsKind(amendmentEvent("amendment_withdrawn", { by }), mesa),
      ).toBeNull();
    }
    expect(
      mesaNewsKind(
        amendmentEvent("amendment_lapsed", { by: "moderator" }),
        mesa,
      ),
    ).toBeNull();
    // An inclusion made ready by an answer the Mesa recorded for a party.
    expect(
      mesaNewsKind(
        amendmentEvent("transactional_revision_ready", {
          revisionId: "r",
          recordedForMemberId: "m2",
        }),
        mesa,
      ),
    ).toBeNull();
    // A party's answer the Mesa recorded for it.
    for (const decision of ["accepted", "rejected"]) {
      expect(
        mesaNewsKind(
          amendmentEvent("acceptance_recorded", {
            memberId: "m2",
            decision,
            recordedForMemberId: "m2",
          }),
          mesa,
        ),
      ).toBeNull();
    }
  });

  it("takes only the acceptance that completed a transactional as ready", () => {
    const party = (
      memberId: string,
      decision: "accepted" | "pending",
      minute: number | null,
    ) => ({
      memberId,
      role: "author" as const,
      decision,
      decidedAt:
        minute === null ? null : new Date(Date.UTC(2026, 10, 25, 10, minute)),
    });
    const transactional = (...acceptances: ReturnType<typeof party>[]) => ({
      kind: "transactional" as const,
      acceptances,
    });
    const done = transactional(
      party("m1", "accepted", 0),
      party("m2", "accepted", 5),
    );
    expect(completesAcceptance({ memberId: "m2" }, done)).toBe(true);
    // An earlier party's acceptance, also when the last was left out.
    expect(completesAcceptance({ memberId: "m1" }, done)).toBe(false);
    expect(
      completesAcceptance(
        { memberId: "m1" },
        transactional(party("m1", "accepted", 0), party("m2", "pending", null)),
      ),
    ).toBe(false);
    expect(completesAcceptance({ memberId: "m1" }, transactional())).toBe(
      false,
    );

    const row = (type: string, payload: Record<string, unknown> = {}) => ({
      type,
      payload,
    });
    const amendment = {
      ...done,
      status: "submitted" as const,
      validatedAt: null,
    };
    expect(
      mesaNewsStands(
        "ready",
        row("acceptance_recorded", { memberId: "m2", decision: "accepted" }),
        amendment,
      ),
    ).toBe(true);
    expect(
      mesaNewsStands(
        "ready",
        row("acceptance_recorded", { memberId: "m1", decision: "accepted" }),
        amendment,
      ),
    ).toBe(false);
    // Decided since: no longer ready.
    expect(
      mesaNewsStands("ready", row("amendment_submitted"), {
        ...amendment,
        status: "withdrawn",
      }),
    ).toBe(false);
    expect(
      mesaNewsStands("ready", row("amendment_submitted"), {
        ...amendment,
        kind: "partial",
      }),
    ).toBe(false);
    // A validation undone, a withdrawal reopened.
    expect(
      mesaNewsStands("validated", row("amendment_validated"), amendment),
    ).toBe(false);
    expect(
      mesaNewsStands("withdrawn", row("amendment_withdrawn"), amendment),
    ).toBe(false);
    expect(
      mesaNewsStands("rejected", row("acceptance_recorded"), {
        ...amendment,
        status: "withdrawn",
      }),
    ).toBe(true);
    // An inclusion ready stands only while it waits for the Secretaría,
    // though the transactional stays undecided once it is applied or
    // cancelled.
    const ready = row("transactional_revision_ready", { revisionId: "r1" });
    expect(
      mesaNewsStands("revision_ready", ready, amendment, "pending_validation"),
    ).toBe(true);
    for (const status of ["applied", "cancelled", "rejected", undefined]) {
      expect(mesaNewsStands("revision_ready", ready, amendment, status)).toBe(
        false,
      );
    }
    expect(
      mesaNewsStands(
        "revision_ready",
        ready,
        { ...amendment, status: "withdrawn" },
        "pending_validation",
      ),
    ).toBe(false);
  });

  it("leaves out the account's own acts, with or without a member", () => {
    const event = (over: Record<string, unknown> = {}) => ({
      type: "amendment_withdrawn",
      payload: { by: "author" } as Record<string, unknown>,
      actorUserId: "other" as string | null,
      actorMemberId: "m9" as string | null,
      impersonationId: null as string | null,
      ...over,
    });
    const noMemberActor = { userId: "me", memberId: null };
    expect(isMesaOthersAct(event(), noMemberActor)).toBe(true);
    expect(isMesaOthersAct(event({ actorUserId: "me" }), noMemberActor)).toBe(
      false,
    );
    // An Admin acting as this account: the account did not do it.
    expect(
      isMesaOthersAct(
        event({ actorUserId: "me", impersonationId: "imp" }),
        noMemberActor,
      ),
    ).toBe(true);
    // Another account of the reader's member.
    expect(
      isMesaOthersAct(event({ actorMemberId: "m1" }), {
        userId: "me",
        memberId: "m1",
      }),
    ).toBe(false);
    // A party's answer is its member's.
    expect(
      isMesaOthersAct(
        event({
          type: "acceptance_recorded",
          payload: { memberId: "m1", decision: "rejected" },
        }),
        { userId: "me", memberId: "m1" },
      ),
    ).toBe(false);
  });

  it("reaches an account without a member, and tells the member's news its own way", () => {
    const validated = amendmentEvent("amendment_validated", {
      admission: "admitted",
      method: "secretaria",
    });
    // No member: empty scopes, the Mesa's only.
    expect(newsRowRole(validated, emptyScope, mesa, noMember)).toEqual({
      presenter: false,
      mesa: "validated",
    });
    expect(newsRowRole(validated, emptyScope, null, noMember)).toBeNull();
    // The reader's own amendment: its own news, never the Mesa's.
    expect(
      newsRowRole(validated, { ...emptyScope, authored: true }, mesa, {
        answeredIds: new Set(),
        authoredIds: new Set(["am1"]),
      }),
    ).toEqual({ presenter: false, mesa: null });
    // An amendment to the reader's document: its arrival tells it (by this
    // event or its publication), so the Mesa's validation does not.
    const asPresenter = {
      answeredIds: new Set(["am1"]),
      authoredIds: new Set<string>(),
    };
    expect(
      newsRowRole(
        validated,
        { ...emptyScope, answered: true },
        mesa,
        asPresenter,
      ),
    ).toEqual({ presenter: true, mesa: null });
    expect(newsRowRole(validated, emptyScope, mesa, asPresenter)).toBeNull();
    // A party's rejection over the reader's own amendment: its own news.
    const rejection = amendmentEvent("acceptance_recorded", {
      memberId: "m2",
      decision: "rejected",
    });
    expect(
      newsRowRole(
        rejection,
        { ...emptyScope, overOwn: true, ownSourceIds: ["s1"] },
        mesa,
        noMember,
      ),
    ).toEqual({ presenter: false, mesa: null });
    expect(newsRowRole(rejection, emptyScope, mesa, noMember)).toEqual({
      presenter: false,
      mesa: "rejected",
    });
  });

  it("merges the Mesa's query with the member's, each event once", () => {
    const at = (iso: string) => new Date(iso);
    const member = [
      { id: "shared", createdAt: at("2026-11-04T10:00:00Z") },
      { id: "m", createdAt: at("2026-11-04T09:00:00Z") },
    ];
    const mesaRows = [
      { id: "x", createdAt: at("2026-11-04T11:00:00Z") },
      { id: "shared", createdAt: at("2026-11-04T10:00:00Z") },
    ];
    expect(
      mergeNewsRows(
        { rows: member, limit: 90 },
        { rows: [], limit: 300 },
        { rows: mesaRows, limit: NEWS_MESA_CANDIDATES },
      ).map((row) => row.id),
    ).toEqual(["x", "shared", "m"]);
  });

  it("never lets a full Mesa query cut the member's older news", () => {
    const at = (iso: string) => new Date(iso);
    const member = [{ id: "own", createdAt: at("2026-11-01T09:00:00Z") }];
    // A deadline's validations fill the Mesa's room, all newer.
    const mesaRows = [
      { id: "v2", createdAt: at("2026-11-04T11:00:00Z") },
      { id: "v1", createdAt: at("2026-11-04T10:00:00Z") },
    ];
    const merged = (cutsOthers?: boolean) =>
      mergeNewsRows(
        { rows: member, limit: 90 },
        { rows: mesaRows, limit: mesaRows.length, cutsOthers },
      ).map((row) => row.id);
    expect(merged(false)).toEqual(["v2", "v1", "own"]);
    // A query that cuts the others (the default) would drop it.
    expect(merged()).toEqual(["v2", "v1"]);
    // A full member query still cuts the Mesa's older rows.
    expect(
      mergeNewsRows(
        { rows: member, limit: 1 },
        {
          rows: [{ id: "old", createdAt: at("2026-10-30T09:00:00Z") }],
          limit: NEWS_MESA_CANDIDATES,
          cutsOthers: false,
        },
      ).map((row) => row.id),
    ).toEqual(["own"]);
  });

  it("keeps each amendment's latest row of each kind", () => {
    const rows: { id: string; entityId: string; mesa: Kind }[] = [
      { id: "v2", entityId: "a", mesa: "validated" },
      { id: "w", entityId: "a", mesa: "withdrawn" },
      { id: "v1", entityId: "a", mesa: "validated" },
      { id: "own1", entityId: "a", mesa: null },
      { id: "own2", entityId: "a", mesa: null },
      { id: "vb", entityId: "b", mesa: "validated" },
    ];
    expect(mesaRowsOnce(rows).map((row) => row.id)).toEqual([
      "v2",
      "w",
      "own1",
      "own2",
      "vb",
    ]);
    // Only a validation repeats the member's news.
    expect(
      mesaRowRepeatsMember("ready", "a", {
        answeredIds: new Set(["a"]),
        authoredIds: new Set(),
      }),
    ).toBe(false);
  });

  it("groups the Mesa's runs by document and kind before the cut", () => {
    const at = (minutes: number) =>
      new Date(Date.UTC(2026, 10, 25, 12, 0) - minutes * 60 * 1000);
    const row = (
      id: string,
      minutes: number,
      over: Partial<{
        type: string;
        mesa: Kind;
        presenter: boolean;
        documentId: string;
        transactional: boolean;
      }> = {},
    ) => ({
      id,
      createdAt: at(minutes),
      type: "amendment_validated",
      payload: {},
      presenter: false,
      mesa: "validated" as Kind,
      documentId: "d1",
      transactional: false,
      ...over,
    });
    // A deadline: 40 validations to one document in a few minutes, then
    // older news that must survive the cut to NEWS_LIMIT.
    const wave = Array.from({ length: 40 }, (_, index) =>
      row(`v${index}`, index * 0.1),
    );
    const rows = [
      ...wave,
      row("other-doc", 5, { documentId: "d2" }),
      row("ready1", 6, {
        type: "acceptance_recorded",
        mesa: "ready",
        transactional: true,
      }),
      row("ready2", 7, {
        type: "amendment_submitted",
        mesa: "ready",
        transactional: true,
      }),
      // Each rejection names its party: alone.
      row("rej1", 8, {
        type: "acceptance_recorded",
        mesa: "rejected",
        transactional: true,
      }),
      row("rej2", 8.5, {
        type: "acceptance_recorded",
        mesa: "rejected",
        transactional: true,
      }),
      // The presenters' arrivals on the same document never join the
      // Mesa's validations.
      row("arrival", 9, { mesa: null, presenter: true }),
      ...Array.from({ length: 30 }, (_, index) =>
        row(`old${index}`, 60 + index * 30, { mesa: null }),
      ),
    ];
    const groups = groupNewsRuns(rows, newsRunKey).slice(0, NEWS_LIMIT);
    expect(groups[0]).toHaveLength(40);
    expect(
      groups.slice(1, 7).map((group) => group.map((item) => item.id)),
    ).toEqual([
      ["other-doc"],
      ["ready1", "ready2"],
      ["rej1"],
      ["rej2"],
      ["arrival"],
      ["old0"],
    ]);
    expect(groups).toHaveLength(NEWS_LIMIT);
  });

  it("keeps late validations apart from on-time ones in the Mesa's runs", () => {
    const at = (minutes: number) =>
      new Date(Date.UTC(2026, 10, 25, 12, 0) - minutes * 60 * 1000);
    const row = (id: string, minutes: number, admission: string) => ({
      id,
      createdAt: at(minutes),
      type: "amendment_validated",
      payload: { admission } as Record<string, unknown>,
      presenter: false,
      mesa: "validated" as Kind,
      documentId: "d1",
      transactional: false,
    });
    const rows = [
      row("on1", 1, "admitted"),
      row("late1", 2, "pending"),
      row("on2", 3, "admitted"),
      row("late2", 4, "pending"),
    ];
    expect(
      groupNewsRuns(rows, newsRunKey).map((group) =>
        group.map((item) => item.id),
      ),
    ).toEqual([
      ["on1", "on2"],
      ["late1", "late2"],
    ]);
  });
});

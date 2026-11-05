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

  it("credits nobody for an older answer the Mesa recorded", () => {
    expect(
      newsByMemberId("position_changed", { by: "moderator" }, "mesa"),
    ).toBeNull();
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

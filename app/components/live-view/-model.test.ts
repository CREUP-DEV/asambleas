import { describe, expect, it } from "vitest";
import type {
  AmendmentDto,
  LiveEventDto,
  PositionDto,
  SpeakersDto,
  SpeakingTurnDto,
  VoteDto,
} from "~~/shared/types/api";
import {
  affectsAgenda,
  affectsSpeakers,
  liveAmendmentCode,
  liveAmendmentCounts,
  liveAmendmentNote,
  liveAmendmentRows,
  liveAmendmentState,
  liveAmendmentStats,
  livePositionLine,
  liveReplacedBy,
  liveSpeakers,
  liveVoteCounts,
  liveVoteSubject,
  liveVoteSubjectText,
} from "./-model";

const turn = (
  id: string,
  over: Partial<SpeakingTurnDto> = {},
): SpeakingTurnDto => ({
  id,
  member: {
    id: `m-${id}`,
    acronym: id.toUpperCase(),
    name: id,
    kind: "asociado",
  },
  speaker: null,
  agendaItemId: "i1",
  status: "waiting",
  position: 0,
  startedAt: null,
  endedAt: null,
  createdAt: "2026-11-14T10:00:00Z",
  updatedAt: "2026-11-14T10:00:00Z",
  ...over,
});

const speakers = (turns: SpeakingTurnDto[], visible = true): SpeakersDto => ({
  visible,
  turns,
});

const amendment = (
  id: string,
  over: Partial<AmendmentDto> = {},
): AmendmentDto => ({
  id,
  documentId: "d1",
  number: 1,
  code: id.toUpperCase(),
  kind: "partial",
  status: "submitted",
  admission: "admitted",
  late: false,
  ops: [],
  globalReplace: null,
  justification: "",
  positionKey: 0,
  changeKinds: [],
  authors: [],
  mainAuthorId: null,
  submittedAt: "2026-11-01T00:00:00Z",
  validatedAt: "2026-11-02T00:00:00Z",
  publishedAt: "2026-11-02T00:00:00Z",
  reviewState: "published",
  correctionNote: null,
  decidedAt: null,
  approvalMethod: null,
  outcomeNote: null,
  outcomeVote: null,
  position: null,
  sourceIds: [],
  transactionalIds: [],
  acceptances: [],
  updatedAt: "2026-11-02T00:00:00Z",
  can: {
    edit: false,
    submit: false,
    withdraw: false,
    accept: false,
    position: false,
    moderate: false,
    review: false,
    validate: false,
    publish: false,
  },
  ...over,
});

const vote = (over: Partial<VoteDto> = {}): VoteDto => ({
  id: "v1",
  subjectType: "amendment",
  subjectId: "a",
  method: "show_of_hands",
  inFavor: 20,
  against: 5,
  abstentions: 2,
  blank: 0,
  invalid: 0,
  present: null,
  majority: "simple",
  result: "approved",
  note: null,
  recordedAt: "2026-11-14T10:30:00Z",
  ...over,
});

describe("live speakers", () => {
  it("stays hidden unless the Mesa shows the turns", () => {
    const dto = speakers([turn("a", { status: "speaking" })]);
    expect(liveSpeakers(dto, false)).toBe(null);
    expect(liveSpeakers(speakers(dto.turns, false), true)).toBe(null);
    expect(liveSpeakers(null, true)).toBe(null);
    expect(liveSpeakers(dto, true)?.current?.id).toBe("a");
  });

  it("keeps the one speaking and the queue in order", () => {
    const dto = speakers([
      turn("done", { status: "done", position: 0 }),
      turn("third", { position: 3 }),
      turn("first", { position: 1 }),
      turn("gone", { status: "cancelled", position: 0 }),
      turn("now", { status: "speaking", startedAt: "2026-11-14T10:05:00Z" }),
      turn("second", { position: 2 }),
      turn("fourth", { position: 4 }),
    ]);
    const view = liveSpeakers(dto, true, 2);
    expect(view?.current?.id).toBe("now");
    expect(view?.next.map((item) => item.id)).toEqual(["first", "second"]);
    expect(view?.more).toBe(2);
  });

  it("shows an empty floor", () => {
    expect(liveSpeakers(speakers([]), true)).toEqual({
      current: null,
      next: [],
      more: 0,
    });
  });

  it("refreshes on speaking-turn and live-state changes", () => {
    const event = (over: Partial<LiveEventDto>): LiveEventDto => ({
      type: "amendment_submitted",
      entityType: "amendment",
      entityId: "x",
      ...over,
    });
    expect(affectsSpeakers([event({})])).toBe(false);
    expect(affectsSpeakers([event({ type: "poll" })])).toBe(true);
    expect(
      affectsSpeakers([event({ type: "live_changed", entityType: "live" })]),
    ).toBe(true);
    expect(
      affectsSpeakers([
        event({ type: "speaking_turn_added", entityType: "speakers" }),
      ]),
    ).toBe(true);
    expect(
      affectsSpeakers([
        event({ type: "speakers_visibility_changed", entityType: "speakers" }),
      ]),
    ).toBe(true);
  });

  it("leaves the agenda alone when only the turns or the live state change", () => {
    const event = (over: Partial<LiveEventDto>): LiveEventDto => ({
      type: "speaking_turn_started",
      entityType: "speakers",
      entityId: "x",
      ...over,
    });
    expect(affectsAgenda([event({})])).toBe(false);
    expect(
      affectsAgenda([
        event({ type: "speakers_visibility_changed" }),
        event({ type: "live_changed", entityType: "live" }),
        event({ type: "amendment_approved", entityType: "amendment" }),
      ]),
    ).toBe(false);
    expect(affectsAgenda([event({ type: "poll" })])).toBe(true);
    for (const entityType of ["assembly", "agenda_item", "document"]) {
      expect(affectsAgenda([event({ type: "changed", entityType })])).toBe(
        true,
      );
    }
  });
});

describe("live amendments", () => {
  it("says where each amendment stands", () => {
    expect(liveAmendmentState(amendment("a"), "a")).toBe("debating");
    expect(liveAmendmentState(amendment("a"), "b")).toBe("pending");
    expect(liveAmendmentState(amendment("a"), null)).toBe("pending");
    expect(
      liveAmendmentState(
        amendment("a", { late: true, admission: "pending" }),
        null,
      ),
    ).toBe("late");
    // Once admitted, a late amendment is debated like any other.
    expect(
      liveAmendmentState(
        amendment("a", { late: true, admission: "admitted" }),
        "a",
      ),
    ).toBe("debating");
    for (const status of [
      "approved",
      "rejected",
      "transacted",
      "withdrawn",
      "lapsed",
      "inadmissible",
    ] as const) {
      // Decided: the outcome wins even while the projection still shows it.
      expect(liveAmendmentState(amendment("a", { status }), "a")).toBe(status);
    }
    // Accepted by the main presenter of a document that incorporates
    // accepted amendments: in the text without a vote.
    expect(
      liveAmendmentState(
        amendment("a", { status: "approved", approvalMethod: "proponent" }),
        "a",
      ),
    ).toBe("incorporated");
    expect(
      liveAmendmentState(
        amendment("a", { status: "approved", approvalMethod: "vote" }),
        null,
      ),
    ).toBe("approved");
  });

  it("counts incorporated amendments as part of the text", () => {
    const rows = liveAmendmentRows(
      [
        amendment("voted", { status: "approved", approvalMethod: "vote" }),
        amendment("in", { status: "approved", approvalMethod: "proponent" }),
        amendment("open"),
      ],
      null,
    );
    expect(liveAmendmentStats(rows)).toEqual({
      approved: 2,
      undecided: 1,
      total: 3,
    });
    expect(liveAmendmentCounts(rows)).toEqual([
      { state: "pending", count: 1 },
      { state: "approved", count: 1 },
      { state: "incorporated", count: 1 },
    ]);
  });

  describe("transactionals", () => {
    const member = (id: string) => ({
      id,
      acronym: id.toUpperCase(),
      name: id,
      kind: "asociado" as const,
    });
    const party = (
      id: string,
      decision: "pending" | "accepted" | "rejected",
    ) => ({
      member: member(id),
      role: "author" as const,
      decision,
      decidedAt: null,
      recordedBy: "party" as const,
    });
    // CEUM 1 and UPV 1 replaced by T1 (accepted by both, still debated);
    // T2 over UPV 1 was turned down by UPV.
    const ceum = amendment("c1", {
      code: "CEUM 1",
      positionKey: 1,
      status: "transacted",
      transactionalIds: ["t1"],
    });
    const upv = amendment("u1", {
      code: "UPV 1",
      positionKey: 2,
      status: "transacted",
      transactionalIds: ["t2", "t1"],
    });
    const t1 = amendment("t1", {
      code: "T1",
      kind: "transactional",
      positionKey: 1,
      sourceIds: ["c1", "u1"],
      acceptances: [party("ceum", "accepted"), party("upv", "accepted")],
    });
    const t2 = amendment("t2", {
      code: "T2",
      kind: "transactional",
      positionKey: 2,
      status: "rejected",
      sourceIds: ["u1"],
      acceptances: [party("upv", "rejected")],
    });
    const rows = liveAmendmentRows([ceum, upv, t1, t2], "t1");
    const row = (id: string) => rows.find((x) => x.amendment.id === id)!;

    it("names the transactional that replaced an amendment", () => {
      expect(liveReplacedBy(row("u1"), rows)?.amendment.id).toBe("t1");
      expect(liveAmendmentNote(row("u1"), rows)).toEqual({
        key: "liveView.state.transacted.by",
        params: { code: "T1" },
      });
      // Not listed (private): the general sentence.
      const alone = liveAmendmentRows([ceum], null);
      expect(liveAmendmentNote(alone[0]!, alone)).toEqual({
        key: "liveView.state.transacted.sentence",
      });
    });

    it("says what a transactional replaced or why it closed", () => {
      expect(liveAmendmentNote(row("t1"), rows)).toEqual({
        key: "liveView.amendments.replaces",
        params: { codes: "CEUM 1, UPV 1" },
      });
      expect(liveAmendmentNote(row("t2"), rows)).toEqual({
        key: "liveView.amendments.turnedDown",
        params: { members: "UPV" },
      });
      // Drafted in the room, not accepted by every main author yet.
      const live = amendment("t3", {
        code: "T3",
        kind: "transactional",
        sourceIds: ["o1"],
        acceptances: [party("ceum", "pending")],
      });
      const open = amendment("o1", {
        code: "CEUM 2",
        transactionalIds: ["t3"],
      });
      const pending = liveAmendmentRows([open, live], null);
      expect(
        liveAmendmentNote(
          pending.find((x) => x.amendment.id === "t3")!,
          pending,
        ),
      ).toEqual({
        key: "liveView.amendments.awaitingAuthors",
        params: { codes: "CEUM 2" },
      });
      expect(
        liveAmendmentNote(
          pending.find((x) => x.amendment.id === "o1")!,
          pending,
        ),
      ).toBe(null);
    });

    it("shows a transactional a main author turned down as such", () => {
      // The server closes it as withdrawn, but nobody withdrew it.
      const closed = { ...t2, status: "withdrawn" as const };
      expect(liveAmendmentState(closed, null)).toBe("turned_down");
      expect(liveAmendmentState(t2, "t2")).toBe("turned_down");
      // Withdrawn by whoever proposed it: still "withdrawn".
      expect(
        liveAmendmentState(
          { ...t2, acceptances: [], status: "withdrawn" },
          null,
        ),
      ).toBe("withdrawn");
      const list = liveAmendmentRows([ceum, upv, t1, closed], null);
      expect(liveAmendmentCounts(list)).toEqual([
        { state: "pending", count: 1 },
        { state: "transacted", count: 2 },
        { state: "turned_down", count: 1 },
      ]);
      // Neither in the text nor still to decide.
      expect(liveAmendmentStats(list)).toEqual({
        approved: 0,
        undecided: 1,
        total: 4,
      });
      expect(
        liveAmendmentNote(
          list.find((x) => x.amendment.id === "t2")!,
          list,
        ),
      ).toEqual({
        key: "liveView.amendments.turnedDown",
        params: { members: "UPV" },
      });
    });

    it("says when another transactional got ahead of one", () => {
      // T4 over UPV 1, drafted in the room after T1 already replaced it:
      // it can never go ahead.
      const t4 = amendment("t4", {
        code: "T4",
        kind: "transactional",
        positionKey: 2,
        sourceIds: ["u1"],
        acceptances: [party("upv", "pending")],
      });
      const list = liveAmendmentRows(
        [ceum, { ...upv, transactionalIds: ["t4", "t1"] }, t1, t4],
        null,
      );
      const find = (id: string) => list.find((x) => x.amendment.id === id)!;
      expect(liveAmendmentNote(find("t4"), list)).toEqual({
        key: "liveView.amendments.superseded",
        params: { codes: "UPV 1" },
      });
      // T1 replaced UPV 1, not the stuck T4 listed first.
      expect(liveReplacedBy(find("u1"), list)?.amendment.id).toBe("t1");
      // Nor does T4 claim what T1 replaced.
      expect(liveAmendmentNote(find("t1"), list)?.key).toBe(
        "liveView.amendments.replaces",
      );
    });

    it("explains late and incorporated amendments", () => {
      const list = liveAmendmentRows(
        [
          amendment("l", { late: true, admission: "pending", positionKey: 1 }),
          amendment("i", {
            status: "approved",
            approvalMethod: "proponent",
            positionKey: 2,
          }),
        ],
        null,
      );
      expect(list.map((x) => liveAmendmentNote(x, list)?.key)).toEqual([
        "liveView.state.late.sentence",
        "liveView.state.incorporated.sentence",
      ]);
    });
  });

  it("lists only what the room can read, in text order", () => {
    const rows = liveAmendmentRows(
      [
        amendment("later", { positionKey: 20, number: 3 }),
        amendment("private", {
          positionKey: 5,
          publishedAt: null,
          reviewState: "validated",
        }),
        amendment("draft", { status: "draft", positionKey: 1 }),
        amendment("first", { positionKey: 10, number: 1 }),
        amendment("won", { positionKey: 15, status: "approved", number: 2 }),
      ],
      "first",
    );
    expect(
      rows.map((row) => [row.amendment.id, row.state, row.current]),
    ).toEqual([
      ["first", "debating", true],
      ["won", "approved", false],
      ["later", "pending", false],
    ]);
    expect(liveAmendmentCounts(rows)).toEqual([
      { state: "debating", count: 1 },
      { state: "pending", count: 1 },
      { state: "approved", count: 1 },
    ]);
  });

  it("counts for the projection only what the room can read", () => {
    const rows = liveAmendmentRows(
      [
        amendment("open"),
        amendment("late", { late: true, admission: "pending" }),
        amendment("won", { status: "approved" }),
        amendment("lost", { status: "rejected" }),
        // Private ones a Mesa or Secretaría account also receives.
        amendment("presenter", {
          publishedAt: null,
          reviewState: "pending_authors",
        }),
        amendment("validated", { publishedAt: null, reviewState: "validated" }),
        amendment("draft", { status: "draft", publishedAt: null }),
      ],
      null,
    );
    expect(liveAmendmentStats(rows)).toEqual({
      approved: 1,
      undecided: 2,
      total: 4,
    });
    expect(liveAmendmentStats([])).toEqual({
      approved: 0,
      undecided: 0,
      total: 0,
    });
  });

  it("labels an amendment by code or number", () => {
    expect(liveAmendmentCode(amendment("a", { code: "CEUM 4" }))).toBe(
      "CEUM 4",
    );
    expect(liveAmendmentCode(amendment("a", { code: null, number: 12 }))).toBe(
      "#12",
    );
    expect(
      liveAmendmentCode(amendment("a", { code: null, number: null })),
    ).toBe("");
    expect(liveAmendmentCode(null)).toBe("");
  });
});

describe("live position line", () => {
  const presenter = { acronym: "CEUM" };
  const answered = (
    position: PositionDto["position"],
    recordedBy: PositionDto["recordedBy"] = "presenter",
  ) =>
    amendment("a", {
      position: {
        position,
        comment: "Por qué",
        recordedBy,
        updatedAt: "2026-11-14T10:00:00Z",
      },
    });

  it("names the main presenter and its answer", () => {
    expect(livePositionLine(answered("accept"), presenter)).toEqual({
      key: "amendment.position.answers.accept",
      params: { member: "CEUM" },
    });
    expect(livePositionLine(answered("reject"), presenter)?.key).toBe(
      "amendment.position.answers.reject",
    );
    expect(livePositionLine(answered("transact"), presenter)?.key).toBe(
      "amendment.position.answers.transact",
    );
  });

  it("says when the Mesa recorded the answer on its behalf", () => {
    expect(livePositionLine(answered("reject", "mesa"), presenter)).toEqual({
      key: "amendment.position.answersByMesa.reject",
      params: { member: "CEUM" },
    });
  });

  it("says nothing without an answer, a position or a main presenter", () => {
    expect(livePositionLine(answered("pending"), presenter)).toBeNull();
    expect(livePositionLine(answered("pending", "mesa"), presenter)).toBeNull();
    expect(livePositionLine(amendment("a"), presenter)).toBeNull();
    expect(livePositionLine(answered("accept"), null)).toBeNull();
    expect(livePositionLine(answered("accept"), undefined)).toBeNull();
  });
});

describe("live votes", () => {
  const context = {
    amendments: [amendment("a", { code: "T1" })],
    document: { id: "d1", title: "Resolución", reference: "RES 012/2026" },
  };

  it("names what was voted", () => {
    expect(liveVoteSubject(vote(), context)).toEqual({
      kind: "amendment",
      code: "T1",
    });
    expect(liveVoteSubject(vote({ subjectId: "hidden" }), context)).toEqual({
      kind: "amendmentUnknown",
    });
    expect(
      liveVoteSubject(
        vote({ subjectType: "document", subjectId: "d1" }),
        context,
      ),
    ).toEqual({ kind: "document", title: "RES 012/2026" });
    expect(
      liveVoteSubject(
        vote({ subjectType: "document", subjectId: "d2" }),
        context,
      ),
    ).toEqual({ kind: "documentUnknown" });
    expect(liveVoteSubject(vote({ subjectType: "decision" }), context)).toEqual(
      { kind: "decision" },
    );
    expect(liveVoteSubject(vote({ subjectType: "other" }), context)).toEqual({
      kind: "other",
    });
  });

  it("words the heading through the translator", () => {
    const t = (key: string, params?: Record<string, unknown>) =>
      params ? `${key}(${JSON.stringify(params)})` : key;
    expect(liveVoteSubjectText({ kind: "amendment", code: "T1" }, t)).toBe(
      'projection.vote.amendment({"code":"T1"})',
    );
    expect(liveVoteSubjectText({ kind: "documentUnknown" }, t)).toBe(
      'projection.vote.document({"title":"projection.vote.documentUnknown"})',
    );
    expect(liveVoteSubjectText({ kind: "other" }, t)).toBe(
      "projection.vote.other",
    );
  });

  it("shows blank and invalid votes only when there were any", () => {
    expect(liveVoteCounts(vote()).map((count) => count.key)).toEqual([
      "inFavor",
      "against",
      "abstentions",
    ]);
    expect(
      liveVoteCounts(vote({ blank: 1, invalid: 2 })).map((count) => [
        count.key,
        count.value,
      ]),
    ).toEqual([
      ["inFavor", 20],
      ["against", 5],
      ["abstentions", 2],
      ["blank", 1],
      ["invalid", 2],
    ]);
  });
});

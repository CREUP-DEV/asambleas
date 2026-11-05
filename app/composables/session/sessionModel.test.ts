import { describe, expect, it } from "vitest";
import type {
  AmendmentDto,
  DocumentSummaryDto,
  SpeakingTurnDto,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  buildSessionQueue,
  isSessionAdmissionEligible,
  isSessionFinalVoteReady,
  isSessionVoteReady,
  sessionAdmissionCandidates,
  sessionAssentPlan,
  sessionCleanVote,
  sessionConsolidatedPreview,
  sessionEmptyVote,
  sessionFinalVoteResult,
  sessionLapseOffer,
  sessionSameBlocks,
  sessionSameIds,
  sessionTransactionalSeed,
  sessionTransactionalParties,
  sessionVoteOutcome,
  buildSessionAgendaRows,
  sessionErrorData,
  sessionQueueOrder,
  sessionQueueCounts,
  sessionValidationIds,
  sessionValidationBreakdown,
  sessionFinalVoteBlockers,
  isSessionAwaitingProponent,
  isSessionAwaitingValidation,
  isSessionDebatable,
  isSessionDecidable,
  isSessionOpen,
  isSessionProponentRejected,
  isSessionTransactable,
  isSessionSpeakersEvent,
  sessionAmendmentStage,
  sessionConnectionState,
  sessionElapsedSeconds,
  sessionFinalVoteReasons,
  sessionFormatDuration,
  sessionNextAgendaTarget,
  sessionNextAmendmentId,
  sessionSpeakers,
  sessionTurnDuration,
  sessionTurnMoveIndex,
  sessionTurnWho,
  isSessionPendingAdmission,
  isSessionPublishable,
  isSessionUndecided,
  isSessionUnpublished,
  isSessionValidatable,
} from "./sessionModel";

const b = (id: string, text: string): Block => ({
  id,
  type: "paragraph",
  text,
  marks: [],
});
const base = [
  b("b1", "El gato come pescado."),
  b("b2", "La casa es grande y bonita."),
  b("b3", "Fin del texto."),
];
let n = 0;
const am = (id: string, over: Partial<AmendmentDto>): AmendmentDto => ({
  id,
  documentId: "d",
  number: ++n,
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
  // Validated and published by the Secretaría unless a test says otherwise.
  submittedAt: "2026-01-01T00:00:00Z",
  validatedAt: "2026-01-01T00:00:00Z",
  publishedAt: "2026-01-01T00:00:00Z",
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
  updatedAt: "2026-01-01T00:00:00Z",
  can: {
    edit: false,
    submit: false,
    withdraw: false,
    accept: false,
    position: false,
    moderate: true,
    review: true,
    validate: false,
    publish: false,
  },
  ...over,
});
/** Presented, not validated by the Secretaría yet. */
const unvalidated = (id: string, over: Partial<AmendmentDto>): AmendmentDto =>
  am(id, {
    admission: "pending",
    validatedAt: null,
    publishedAt: null,
    reviewState: "pending_validation",
    ...over,
  });
const rep = (blockId: string, from: number, to: number, text: string) => {
  const bt = base.find((x) => x.id === blockId)!.text.slice(from, to);
  return { op: "replace" as const, blockId, from, to, text, baseText: bt };
};

describe("session model", () => {
  const a1 = am("a1", { ops: [rep("b2", 3, 7, "choza")], positionKey: 1.1 });
  const a2 = am("a2", {
    ops: [rep("b2", 3, 15, "choza es")],
    positionKey: 1.1,
  });
  const a3 = am("a3", { ops: [rep("b1", 3, 7, "perro")], positionKey: 0.1 });
  const a4 = am("a4", {
    ops: [rep("b3", 0, 3, "Final")],
    positionKey: 2,
    admission: "pending",
    late: true,
  });
  const a5 = am("a5", {
    status: "draft",
    positionKey: 0,
    submittedAt: null,
    validatedAt: null,
    publishedAt: null,
    reviewState: null,
  });

  it("builds a queue", () => {
    const q = buildSessionQueue([a1, a2, a3, a4, a5]);
    expect(q.validation).toEqual([]);
    expect(q.pending.map((x) => x.id)).toEqual(["a4"]);
    expect(
      q.entries.map((e) =>
        e.type === "cluster"
          ? e.amendments.map((x) => x.id).join("+")
          : e.amendment.id,
      ),
    ).toEqual(["a3", "a1+a2"]);
    expect(sessionQueueOrder(q)).toEqual(["a4", "a3", "a1", "a2"]);
  });

  describe("validation by the Secretaría", () => {
    // Presented on time, not validated: overlaps a1 but must not join it.
    const v1 = unvalidated("v1", {
      ops: [rep("b2", 3, 7, "cabaña")],
      positionKey: 1.1,
      can: { ...a1.can, validate: true },
    });
    // Presented late, not validated.
    const v2 = unvalidated("v2", { positionKey: 0.5, late: true });
    // Sent back to its authors: a draft again, with a note.
    const v3 = unvalidated("v3", {
      status: "draft",
      positionKey: 0.2,
      reviewState: "correction_requested",
      correctionNote: "Falta la justificación",
    });
    // Validated, not published: debated like any other.
    const hidden = am("h1", {
      positionKey: 3,
      publishedAt: null,
      reviewState: "validated",
      can: { ...a1.can, publish: true },
    });

    it("keeps unvalidated amendments out of the debate", () => {
      const q = buildSessionQueue([a1, a2, a3, a4, a5, v1, v2, v3, hidden]);
      expect(q.validation.map((x) => x.id)).toEqual(["v3", "v2", "v1"]);
      // v2's admission is pending, but it is not the Mesa's to admit yet.
      expect(q.pending.map((x) => x.id)).toEqual(["a4"]);
      expect(
        q.entries.map((e) =>
          e.type === "cluster"
            ? e.amendments.map((x) => x.id).join("+")
            : e.amendment.id,
        ),
      ).toEqual(["a3", "a1+a2", "h1"]);
      // The folded group is not reachable with j/k.
      expect(sessionQueueOrder(q)).toEqual(["a4", "a3", "a1", "a2", "h1"]);
    });

    it("leaves plain drafts out and counts the group apart", () => {
      const q = buildSessionQueue([a5, v3]);
      expect(q.validation.map((x) => x.id)).toEqual(["v3"]);
      expect(sessionQueueCounts([a1, a4, a5, v1, v2, v3, hidden])).toEqual({
        total: 3,
        undecided: 3,
        approved: 0,
        awaitingValidation: 3,
      });
      expect(
        sessionQueueCounts([{ ...a1, status: "approved" }, a5]),
      ).toMatchObject({ total: 1, undecided: 0, approved: 1 });
    });

    it("classifies review states", () => {
      expect(isSessionAwaitingValidation(v1)).toBe(true);
      expect(isSessionAwaitingValidation(v3)).toBe(true);
      expect(isSessionAwaitingValidation(a5)).toBe(false);
      expect(isSessionAwaitingValidation(hidden)).toBe(false);
      // Withdrawn before validation: closed, not waiting for anything.
      expect(isSessionAwaitingValidation({ ...v2, status: "withdrawn" })).toBe(
        false,
      );

      expect(isSessionOpen(v1)).toBe(false);
      expect(isSessionOpen({ ...v1, admission: "admitted" })).toBe(false);
      expect(isSessionOpen(hidden)).toBe(true);
      expect(isSessionPendingAdmission(v2)).toBe(false);
      expect(isSessionPendingAdmission(a4)).toBe(true);
      expect(isSessionUndecided(v1)).toBe(false);
      expect(isSessionUndecided(hidden)).toBe(true);

      expect(isSessionUnpublished(hidden)).toBe(true);
      expect(isSessionUnpublished(a1)).toBe(false);
      expect(isSessionPublishable(hidden)).toBe(true);
      expect(isSessionPublishable({ ...hidden, can: a1.can })).toBe(false);

      expect(isSessionValidatable(v1)).toBe(true);
      // Without the permission, or already back with its authors.
      expect(isSessionValidatable(v2)).toBe(false);
      expect(
        isSessionValidatable({ ...v3, can: { ...v3.can, validate: true } }),
      ).toBe(false);
    });

    it("lists what a bulk validation sends", () => {
      const v4 = unvalidated("v4", {
        positionKey: 0.1,
        can: { ...a1.can, validate: true },
      });
      const list = [a1, v1, v2, v3, v4, hidden];
      expect(sessionValidationIds(list)).toEqual(["v4", "v1"]);
      expect(sessionValidationIds(list, ["v1", "v2", "a1"])).toEqual(["v1"]);
      expect(sessionValidationIds(list, [])).toEqual([]);
    });

    it("says who the folded group waits for", () => {
      expect(sessionValidationBreakdown([a1, a5, v1, v2, v3, hidden])).toEqual({
        toValidate: 2,
        inCorrection: 1,
        awaitingProponent: 0,
        proponentRejected: 0,
      });
      expect(sessionValidationBreakdown([a1, hidden])).toEqual({
        toValidate: 0,
        inCorrection: 0,
        awaitingProponent: 0,
        proponentRejected: 0,
      });
    });

    it("splits what blocks the final vote by who has to act", () => {
      // v3 is a draft again (sent back): it no longer blocks the vote.
      const decided = { ...a2, status: "approved" as const };
      expect(
        sessionFinalVoteBlockers([a1, decided, a4, a5, v1, v2, v3, hidden]),
      ).toEqual({
        undecided: ["a1", "a4", "h1"],
        awaitingValidation: ["v2", "v1"],
        awaitingProponent: [],
        proponentRejected: [],
      });
      expect(sessionFinalVoteBlockers([decided, a5])).toEqual({
        undecided: [],
        awaitingValidation: [],
        awaitingProponent: [],
        proponentRejected: [],
      });
    });

    it("adds the ids a refused final vote reported", () => {
      const decided = { ...a2, status: "approved" as const };
      // "x9" is not loaded yet; a2 was decided since the server answered.
      expect(
        sessionFinalVoteBlockers([a1, decided, v1], ["v1", "a2", "x9", "a1"]),
      ).toEqual({
        undecided: ["a1", "x9"],
        awaitingValidation: ["v1"],
        awaitingProponent: [],
        proponentRejected: [],
      });
    });

    it("never offers unvalidated amendments for admission", () => {
      const list = [a1, a4, v1, v2];
      expect(isSessionAdmissionEligible(v2, "admitted")).toBe(false);
      expect(isSessionAdmissionEligible(v1, "inadmissible")).toBe(false);
      const ids = (
        decision: "admitted" | "inadmissible",
        requested?: string[],
      ) =>
        sessionAdmissionCandidates(list, decision, requested).map((x) => x.id);
      expect(ids("admitted")).toEqual(["a4"]);
      expect(ids("admitted", ["v2"])).toEqual(["a4"]);
      expect(ids("inadmissible", ["v1", "a1"])).toEqual(["a1", "a4"]);
    });

    it("never offers unvalidated amendments to lapse or assent", () => {
      const approved = { ...a1, status: "approved" as const };
      const offer = sessionLapseOffer(approved, [approved, a2, v1], [], {
        overlapsWithApproved: [],
        incompatible: ["v1"],
      });
      expect(offer.lapse).toEqual(["a2"]);

      const accept = {
        position: "accept" as const,
        comment: null,
        updatedAt: "",
      };
      const plan = sessionAssentPlan([
        { ...v1, admission: "admitted", position: accept },
        { ...a3, position: accept },
      ]);
      expect(plan.ready.map((x) => x.id)).toEqual(["a3"]);
      expect(plan.skipped).toEqual([]);
    });
  });

  it("offers lapses", () => {
    const approved = { ...a1, status: "approved" as const };
    const offer = sessionLapseOffer(
      approved,
      [approved, a2, a3],
      [
        {
          id: "r",
          fromId: "a3",
          toId: "a1",
          kind: "incompatible",
          note: null,
          createdAt: "",
        },
      ],
      { overlapsWithApproved: [], incompatible: ["a3"] },
    );
    expect(offer.lapse.sort()).toEqual(["a2", "a3"]);
    expect(offer.collisions).toEqual([]);
  });

  it("plans bulk assent", () => {
    const accept = {
      position: "accept" as const,
      comment: null,
      updatedAt: "",
    };
    const plan = sessionAssentPlan([
      { ...a1, position: accept },
      { ...a2, position: accept },
      { ...a3, position: accept },
    ]);
    expect(plan.ready.map((x) => x.id)).toEqual(["a3", "a1"]);
    expect(plan.skipped.map((x) => [x.amendment.id, x.reason])).toEqual([
      ["a2", "overlap_candidate"],
    ]);
  });

  it("previews consolidation with conflicts", () => {
    const p = sessionConsolidatedPreview(base, [
      { ...a1, status: "approved", decidedAt: "2026-01-01T10:00:00Z" },
      { ...a2, status: "approved", decidedAt: "2026-01-01T11:00:00Z" },
    ]);
    expect(p.applied).toEqual(["a1"]);
    expect(p.conflicts[0]).toEqual({
      amendmentId: "a2",
      conflictsWith: ["a1"],
    });
    expect(p.blocks[1]!.text).toBe("La choza es grande y bonita.");
  });

  it("seeds a transactional and diffs back", () => {
    const ins = am("a6", {
      ops: [
        {
          op: "insert",
          afterBlockId: "b2",
          blocks: [b("nb", "Nuevo párrafo.")],
        },
      ],
    });
    const seed = sessionTransactionalSeed(
      base,
      [a1, a2, a3, ins],
      () => "fresh" + Math.random().toString(36).slice(2, 8),
    );
    expect(seed.passage.map((x) => x.id)).toEqual(["b1", "b2"]);
    expect(seed.anchorBefore).toBe(null);
    expect(seed.skipped).toEqual(["a2"]);
    expect(seed.seed.map((x) => x.text)).toEqual([
      "El perro come pescado.",
      "La choza es grande y bonita.",
      "Nuevo párrafo.",
    ]);
    let k = 0;
    const ops = diffPassage(
      seed.passage,
      seed.seed,
      seed.anchorBefore,
      () => "x" + ++k,
    );
    expect(validateOps(base, ops)).toEqual([]);
    // Passage in the middle
    const seed2 = sessionTransactionalSeed(base, [a1], () => "q");
    expect(seed2.anchorBefore).toBe("b1");
    const seed3 = sessionTransactionalSeed(
      base,
      [am("t", { kind: "totality_return" })],
      () => "q",
    );
    expect(seed3.passage).toEqual([]);
    const del = am("d1", { ops: [{ op: "delete", blockIds: ["b3"] }] });
    const seed4 = sessionTransactionalSeed(base, [del, a1], () => "q");
    expect(seed4.passage.map((x) => x.id)).toEqual(["b2", "b3"]);
    expect(seed4.seed.map((x) => x.id)).toEqual(["b2"]);
    const ops4 = diffPassage(
      seed4.passage,
      seed4.seed,
      seed4.anchorBefore,
      () => "y",
    );
    expect(validateOps(base, ops4)).toEqual([]);
    expect(ops4.some((o) => o.op === "delete")).toBe(true);
  });

  it("lists parties", () => {
    const m = (id: string) => ({
      id,
      acronym: id,
      name: id,
      kind: "asociado" as const,
    });
    const parties = sessionTransactionalParties(
      [
        am("x", { authors: [m("A"), m("B")] }),
        am("y", { authors: [m("B"), m("C")] }),
      ],
      m("A"),
    );
    expect(parties.map((p) => [p.member.id, p.role])).toEqual([
      ["A", "author"],
      ["B", "author"],
      ["C", "author"],
    ]);
  });

  it("flattens agenda", () => {
    const it = (id: string, parentId: string | null, order: number) => ({
      id,
      parentId,
      title: id,
      description: null,
      order,
      acceptsSubmissions: false,
      updatedAt: "",
    });
    const rows = buildSessionAgendaRows(
      [it("c", "a", 1), it("a", null, 1), it("b", null, 0), it("d", "a", 0)],
      [],
    );
    expect(rows.map((r) => `${r.number}:${r.item.id}`)).toEqual([
      "1:b",
      "2:a",
      "2.1:d",
      "2.2:c",
    ]);
  });

  it("reads error data", () => {
    expect(
      sessionErrorData({ data: { statusCode: 409, data: { tie: true } } }),
    ).toEqual({ tie: true });
    expect(
      sessionErrorData({
        data: { statusCode: 409, data: { totalityReturn: "t1" } },
      }),
    ).toEqual({ totalityReturn: "t1" });
    expect(sessionErrorData(new Error("x"))).toBe(null);
  });

  it("decides who can be admitted or declared inadmissible", () => {
    const onTime = a1;
    const late = a4;
    const inadmissible = am("i1", {
      status: "inadmissible",
      admission: "inadmissible",
      late: true,
      positionKey: 3,
    });
    const approved = am("p1", { status: "approved", positionKey: 4 });

    // Mirrors the server: inadmission for any undecided amendment, admission
    // for pending ones and to re-admit inadmissible ones.
    expect(isSessionAdmissionEligible(onTime, "inadmissible")).toBe(true);
    expect(isSessionAdmissionEligible(late, "inadmissible")).toBe(true);
    expect(isSessionAdmissionEligible(inadmissible, "inadmissible")).toBe(
      false,
    );
    expect(isSessionAdmissionEligible(approved, "inadmissible")).toBe(false);
    expect(isSessionAdmissionEligible(onTime, "admitted")).toBe(false);
    expect(isSessionAdmissionEligible(late, "admitted")).toBe(true);
    expect(isSessionAdmissionEligible(inadmissible, "admitted")).toBe(true);
    expect(isSessionAdmissionEligible(approved, "admitted")).toBe(false);

    const list = [onTime, late, inadmissible, approved, a5];
    const ids = (decision: "admitted" | "inadmissible", requested?: string[]) =>
      sessionAdmissionCandidates(list, decision, requested).map((x) => x.id);

    // Bulk actions only reach the amendments pending admission.
    expect(ids("admitted")).toEqual(["a4"]);
    expect(ids("inadmissible")).toEqual(["a4"]);
    // From a card: re-admit an inadmissible one, or inadmit an on-time one.
    expect(ids("admitted", ["i1"])).toEqual(["a4", "i1"]);
    expect(ids("inadmissible", ["a1"])).toEqual(["a1", "a4"]);
    // Requested ids the server would refuse are left out.
    expect(ids("admitted", ["a1", "p1"])).toEqual(["a4"]);
    expect(ids("inadmissible", ["i1"])).toEqual(["a4"]);
  });

  it("offers to lapse everything after a totality return", () => {
    const ret = am("t1", {
      kind: "totality_return",
      status: "approved",
      positionKey: 0,
    });
    const decided = am("w1", { status: "withdrawn", positionKey: 5 });
    const offer = sessionLapseOffer(ret, [ret, a2, a1, a4, decided, a5], []);
    // a4 is late: until the assembly agrees to treat it, it cannot lapse.
    expect(offer.lapse).toEqual(["a1", "a2"]);
    expect(offer.collisions).toEqual([]);
    // A rejected return offers nothing.
    expect(
      sessionLapseOffer({ ...ret, status: "rejected" }, [ret, a1], []).lapse,
    ).toEqual([]);
  });

  it("records a final vote by assent", () => {
    const settings = {
      denominator: "valid_votes",
      tieRule: "repeat",
    } as const;
    const empty = sessionEmptyVote("simple");
    const emptyOutcome = sessionVoteOutcome(empty, settings);
    expect(isSessionVoteReady(empty, emptyOutcome)).toBe(false);
    expect(isSessionFinalVoteReady(empty, emptyOutcome)).toBe(false);

    const assent = { ...empty, method: "assent" as const, note: "  Actas " };
    const assentOutcome = sessionVoteOutcome(assent, settings);
    expect(isSessionFinalVoteReady(assent, assentOutcome)).toBe(true);
    expect(sessionFinalVoteResult(assent, assentOutcome)).toBe("approved");
    // Only the method and the note travel: no counts, present or majority.
    expect(sessionCleanVote(assent)).toEqual({
      method: "assent",
      note: "Actas",
    });

    const hands = { ...empty, inFavor: 30, against: 12 };
    const handsOutcome = sessionVoteOutcome(hands, settings);
    expect(isSessionFinalVoteReady(hands, handsOutcome)).toBe(true);
    expect(sessionFinalVoteResult(hands, handsOutcome)).toBe("approved");
    expect(sessionCleanVote(hands)).toMatchObject({
      method: "show_of_hands",
      inFavor: 30,
      against: 12,
      majority: "simple",
    });
  });

  it("compares drafts and source sets", () => {
    expect(sessionSameIds(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(sessionSameIds(["a"], ["a", "b"])).toBe(false);
    expect(sessionSameIds([], [])).toBe(true);

    const renamed = base.map((block, i) => ({ ...block, id: `n${i}` }));
    expect(sessionSameBlocks(base, renamed)).toBe(true);
    expect(
      sessionSameBlocks(base, [
        base[0]!,
        { ...base[1]!, text: "La casa es pequeña." },
        base[2]!,
      ]),
    ).toBe(false);
    expect(sessionSameBlocks(base, base.slice(0, 2))).toBe(false);
    expect(
      sessionSameBlocks(
        [base[0]!],
        [{ ...base[0]!, marks: [{ type: "bold", from: 0, to: 2 }] }],
      ),
    ).toBe(false);
  });

  describe("transactionals waiting for the document's presenter", () => {
    // Proposed by a member over a1 and a2: submitted, admission pending.
    const tp = am("tp", {
      kind: "transactional",
      positionKey: 1.1,
      admission: "pending",
      validatedAt: null,
      publishedAt: null,
      reviewState: "pending_proponent",
      sourceIds: ["a1", "a2"],
    });
    const tpDraft = { ...tp, id: "tpd", status: "draft" as const };

    it("keeps them out of the debate and of the late group", () => {
      expect(isSessionAwaitingProponent(tp)).toBe(true);
      expect(isSessionAwaitingProponent(tpDraft)).toBe(true);
      expect(isSessionAwaitingValidation(tp)).toBe(true);
      expect(isSessionPendingAdmission(tp)).toBe(false);
      expect(isSessionOpen(tp)).toBe(false);
      expect(isSessionAdmissionEligible(tp, "admitted")).toBe(false);
      // Withdrawn before the presenter answered: closed.
      expect(isSessionAwaitingProponent({ ...tp, status: "withdrawn" })).toBe(
        false,
      );

      const q = buildSessionQueue([a1, a2, a4, tp, tpDraft]);
      expect(q.validation.map((x) => x.id)).toEqual(["tp", "tpd"]);
      expect(q.pending.map((x) => x.id)).toEqual(["a4"]);
      expect(sessionQueueOrder(q)).toEqual(["a4", "a1", "a2"]);
    });

    it("counts them apart in the folded group and the final vote", () => {
      const v1 = unvalidated("v1", {});
      expect(sessionValidationBreakdown([tp, tpDraft, v1])).toEqual({
        toValidate: 1,
        inCorrection: 0,
        awaitingProponent: 2,
        proponentRejected: 0,
      });
      expect(sessionFinalVoteBlockers([a1, tp, v1])).toEqual({
        undecided: ["a1"],
        awaitingValidation: ["v1"],
        awaitingProponent: ["tp"],
        proponentRejected: [],
      });
    });

    describe("turned down by the presenter", () => {
      const party = (
        id: string,
        role: "author" | "proponent",
        decision: "pending" | "accepted" | "rejected",
      ) => ({
        member: { id, acronym: id.toUpperCase(), name: id, kind: "asociado" },
        role,
        decision,
        decidedAt: null,
      });
      // The presenter (cea) answered no with its proponent row.
      const rejected = {
        ...tp,
        id: "tr",
        acceptances: [
          party("ceum", "author", "accepted"),
          party("cea", "proponent", "rejected"),
        ],
      } as AmendmentDto;
      // The presenter also wrote a source: its one row says "author".
      const rejectedAsAuthor = {
        ...tp,
        id: "ta",
        acceptances: [
          party("ceum", "author", "accepted"),
          party("cea", "author", "rejected"),
        ],
      } as AmendmentDto;
      // Only a source author said no: still the presenter's turn.
      const authorSaidNo = {
        ...tp,
        id: "tn",
        acceptances: [
          party("ceum", "author", "rejected"),
          party("cea", "proponent", "pending"),
        ],
      } as AmendmentDto;

      it("tells them from those still waiting", () => {
        expect(isSessionProponentRejected(rejected)).toBe(true);
        expect(isSessionProponentRejected(rejected, "cea")).toBe(true);
        expect(isSessionProponentRejected(rejectedAsAuthor)).toBe(false);
        expect(isSessionProponentRejected(rejectedAsAuthor, "cea")).toBe(true);
        expect(isSessionProponentRejected(authorSaidNo, "cea")).toBe(false);
        expect(isSessionProponentRejected(tp, "cea")).toBe(false);
        // Withdrawn since: nothing waits any more.
        expect(
          isSessionProponentRejected(
            { ...rejected, status: "withdrawn", reviewState: null },
            "cea",
          ),
        ).toBe(false);
        expect(sessionAmendmentStage(rejected)).toBe("proponent_rejected");
        expect(sessionAmendmentStage(rejectedAsAuthor, "cea")).toBe(
          "proponent_rejected",
        );
        expect(sessionAmendmentStage(authorSaidNo, "cea")).toBe(
          "awaiting_proponent",
        );
      });

      it("says the final vote waits for its withdrawal", () => {
        const list = [a1, tp, rejectedAsAuthor];
        expect(sessionValidationBreakdown(list, "cea")).toEqual({
          toValidate: 0,
          inCorrection: 0,
          awaitingProponent: 1,
          proponentRejected: 1,
        });
        const blockers = sessionFinalVoteBlockers(list, [], "cea");
        expect(blockers).toEqual({
          undecided: ["a1"],
          awaitingValidation: [],
          awaitingProponent: ["tp"],
          proponentRejected: ["ta"],
        });
        expect(
          sessionFinalVoteReasons({
            document: { voted: true, status: "published" },
            amendmentsLoaded: true,
            totalityReturnId: null,
            blockers,
          }),
        ).toEqual([
          { key: "undecided", count: 1 },
          { key: "awaitingProponent", count: 1 },
          { key: "proponentRejected", count: 1 },
        ]);
      });
    });
  });

  describe("debate", () => {
    it("says where an amendment stands", () => {
      const stage = (over: Partial<AmendmentDto>) =>
        sessionAmendmentStage(am("s", over));
      expect(stage({})).toBe("open");
      expect(stage({ admission: "pending", late: true })).toBe("late");
      expect(
        stage({
          kind: "transactional",
          acceptances: [
            {
              member: { id: "m", acronym: "M", name: "M", kind: "asociado" },
              role: "author",
              decision: "pending",
              decidedAt: null,
            },
          ],
        }),
      ).toBe("acceptances");
      expect(stage({ status: "approved" })).toBe("approved");
      expect(stage({ status: "transacted" })).toBe("transacted");
      expect(stage({ reviewState: "pending_proponent" })).toBe(
        "awaiting_proponent",
      );
      expect(
        stage({ admission: "pending", reviewState: "pending_validation" }),
      ).toBe("awaiting_validation");
      expect(
        stage({ status: "draft", reviewState: "correction_requested" }),
      ).toBe("correction_requested");
    });

    it("picks the next amendment the Mesa can decide", () => {
      // a3 (0.1), a1 + a2 (1.1, one cluster), d1 decided, u1 unvalidated,
      // a4 late and not admitted yet.
      const d1 = am("d1", { status: "approved", positionKey: 1.5 });
      const u1 = unvalidated("u1", { positionKey: 1.6 });
      const q = buildSessionQueue([a1, a2, a3, a4, d1, u1]);
      expect(sessionNextAmendmentId(q, null)).toBe("a3");
      expect(sessionNextAmendmentId(q, "a3")).toBe("a1");
      expect(sessionNextAmendmentId(q, "a1")).toBe("a2");
      // After the last one, back to those skipped before it.
      expect(sessionNextAmendmentId(q, "a2")).toBe("a3");
      // From a decided one, the next open one after it.
      expect(sessionNextAmendmentId(q, "d1")).toBe("a3");
      expect(sessionNextAmendmentId(q, "a4")).toBe("a3");
      // Late, unvalidated and decided ones are never offered.
      expect(
        sessionNextAmendmentId(buildSessionQueue([a4, d1, u1]), null),
      ).toBe(null);
      // Nothing else left.
      expect(sessionNextAmendmentId(buildSessionQueue([a3, d1]), "a3")).toBe(
        null,
      );
    });

    it("skips private amendments the actor cannot publish", () => {
      // p1 (0.5) is validated but private: the projection cannot show it.
      const p1 = am("p1", {
        positionKey: 0.5,
        publishedAt: null,
        reviewState: "validated",
      });
      const canPublish = { ...p1, can: { ...p1.can, publish: true } };
      expect(isSessionOpen(p1)).toBe(true);
      expect(isSessionDebatable(p1)).toBe(false);
      expect(isSessionDebatable(canPublish)).toBe(true);
      // Nobody decides or transacts it while it is private.
      expect(isSessionDecidable(canPublish)).toBe(false);
      expect(isSessionDecidable(a3)).toBe(true);
      expect(isSessionTransactable(canPublish)).toBe(false);
      expect(isSessionTransactable(a3)).toBe(true);
      const hidden2 = {
        ...a2,
        publishedAt: null,
        reviewState: "validated" as const,
      };
      const cluster = buildSessionQueue([a1, hidden2]).entries[0];
      expect(cluster?.type === "cluster" ? cluster.openIds : null).toEqual([
        "a1",
      ]);

      // A plain moderator goes from a3 straight to a1.
      expect(
        sessionNextAmendmentId(buildSessionQueue([a1, a3, p1]), "a3"),
      ).toBe("a1");
      expect(sessionNextAmendmentId(buildSessionQueue([p1]), null)).toBe(null);
      // Whoever can publish it is offered it (publish, then debate).
      expect(
        sessionNextAmendmentId(buildSessionQueue([a1, a3, canPublish]), "a3"),
      ).toBe("p1");
      // Nor is it approved in bulk by assent.
      const accept = {
        position: "accept" as const,
        comment: null,
        updatedAt: "",
      };
      expect(
        sessionAssentPlan([{ ...canPublish, position: accept }]).ready,
      ).toEqual([]);
    });

    it("never lapses a late amendment the assembly has not agreed to treat", () => {
      const approved = { ...a3, status: "approved" as const };
      const offer = sessionLapseOffer(approved, [approved, a4], [], {
        overlapsWithApproved: [],
        incompatible: ["a4"],
      });
      expect(offer.lapse).toEqual([]);
      const admitted = { ...a4, admission: "admitted" as const };
      expect(
        sessionLapseOffer(approved, [approved, admitted], [], {
          overlapsWithApproved: [],
          incompatible: ["a4"],
        }).lapse,
      ).toEqual(["a4"]);
    });

    it("finds the next agenda item and its only document", () => {
      const item = (id: string, order: number) => ({
        id,
        parentId: null,
        title: id,
        description: null,
        order,
        acceptsSubmissions: false,
        updatedAt: "",
      });
      const doc = (id: string, agendaItemId: string, status: string) =>
        ({ id, agendaItemId, status }) as unknown as DocumentSummaryDto;
      const rows = buildSessionAgendaRows(
        [item("i1", 0), item("i2", 1), item("i3", 2)],
        [
          doc("d1", "i2", "published"),
          doc("d2", "i2", "draft"),
          doc("d3", "i3", "published"),
          doc("d4", "i3", "published"),
        ],
      );
      const target = (current: string | null) => {
        const next = sessionNextAgendaTarget(rows, current);
        return next ? [next.row.item.id, next.document?.id ?? null] : null;
      };
      expect(target(null)).toEqual(["i1", null]);
      expect(target("i1")).toEqual(["i2", "d1"]);
      // Two published documents: the Mesa chooses.
      expect(target("i2")).toEqual(["i3", null]);
      expect(target("i3")).toBe(null);
      expect(target("missing")).toEqual(["i1", null]);
    });

    it("explains why the final vote waits", () => {
      type Input = Parameters<typeof sessionFinalVoteReasons>[0];
      const blockers = sessionFinalVoteBlockers([a1]);
      const reasons = (over: Partial<Input>) =>
        sessionFinalVoteReasons({
          document: { voted: true, status: "published" },
          amendmentsLoaded: true,
          totalityReturnId: null,
          blockers,
          ...over,
        }).map((reason) => reason.key);
      expect(reasons({ document: null })).toEqual([]);
      expect(
        reasons({ document: { voted: false, status: "published" } }),
      ).toEqual(["notVoted"]);
      expect(reasons({ document: { voted: true, status: "draft" } })).toEqual([
        "notPublished",
      ]);
      expect(reasons({ amendmentsLoaded: false })).toEqual([
        "amendmentsLoading",
      ]);
      expect(reasons({ totalityReturnId: "t1" })).toEqual(["totalityReturn"]);
      expect(reasons({})).toEqual(["undecided"]);
      const decided = { ...a1, status: "approved" as const };
      expect(
        reasons({ blockers: sessionFinalVoteBlockers([decided]) }),
      ).toEqual([]);
    });
  });

  it("says connecting until the first connection", () => {
    expect(sessionConnectionState(false, false, false)).toBe("connecting");
    expect(sessionConnectionState(true, false, false)).toBe("live");
    expect(sessionConnectionState(false, true, false)).toBe("polling");
    expect(sessionConnectionState(false, false, true)).toBe("offline");
    expect(sessionConnectionState(true, true, true)).toBe("live");
  });

  describe("speaking turns", () => {
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
      agendaItemId: null,
      status: "waiting",
      position: 0,
      startedAt: null,
      endedAt: null,
      createdAt: "2026-01-01T10:00:00Z",
      updatedAt: "2026-01-01T10:00:00Z",
      ...over,
    });

    it("splits who speaks, who waits and who spoke", () => {
      const view = sessionSpeakers([
        turn("c", { position: 2 }),
        turn("a", { position: 0 }),
        turn("b", { position: 1 }),
        turn("tie", { position: 1, createdAt: "2026-01-01T11:00:00Z" }),
        turn("s", { status: "speaking", startedAt: "2026-01-01T10:05:00Z" }),
        turn("d1", {
          status: "done",
          startedAt: "2026-01-01T10:00:00Z",
          endedAt: "2026-01-01T10:02:00Z",
        }),
        turn("d2", {
          status: "done",
          startedAt: "2026-01-01T10:02:00Z",
          endedAt: "2026-01-01T10:04:30Z",
        }),
        turn("x", { status: "cancelled" }),
      ]);
      expect(view.speaking?.id).toBe("s");
      expect(view.waiting.map((x) => x.id)).toEqual(["a", "b", "tie", "c"]);
      expect(view.done.map((x) => x.id)).toEqual(["d2", "d1"]);
      expect(sessionTurnDuration(view.done[0]!)).toBe(150);
      expect(sessionTurnDuration(turn("w"))).toBe(null);
      expect(sessionSpeakers([]).speaking).toBe(null);
    });

    it("moves a waiting turn one place", () => {
      const waiting = [turn("a"), turn("b"), turn("c")];
      expect(sessionTurnMoveIndex(waiting, "b", -1)).toBe(0);
      expect(sessionTurnMoveIndex(waiting, "b", 1)).toBe(2);
      expect(sessionTurnMoveIndex(waiting, "a", -1)).toBe(null);
      expect(sessionTurnMoveIndex(waiting, "c", 1)).toBe(null);
      expect(sessionTurnMoveIndex(waiting, "zz", 1)).toBe(null);
    });

    it("times the current speaker", () => {
      const start = "2026-01-01T10:00:00Z";
      const at = (iso: string) => new Date(iso).getTime();
      expect(sessionElapsedSeconds(start, at("2026-01-01T10:01:05.900Z"))).toBe(
        65,
      );
      // The client clock may run behind the server's.
      expect(sessionElapsedSeconds(start, at("2026-01-01T09:59:58Z"))).toBe(0);
      expect(sessionElapsedSeconds(null, Date.now())).toBe(0);
      expect(sessionElapsedSeconds("nonsense", Date.now())).toBe(0);
      expect(sessionFormatDuration(0)).toBe("0:00");
      expect(sessionFormatDuration(65)).toBe("1:05");
      expect(sessionFormatDuration(3725)).toBe("1:02:05");
    });

    it("names who a turn is for", () => {
      expect(sessionTurnWho(turn("ceum", { speaker: " Ana Pérez " }))).toBe(
        "CEUM (Ana Pérez)",
      );
      expect(sessionTurnWho(turn("ceum"))).toBe("CEUM");
      expect(sessionTurnWho(turn("x", { member: null, speaker: "Ana" }))).toBe(
        "Ana",
      );
      expect(sessionTurnWho(turn("x", { member: null, speaker: "  " }))).toBe(
        null,
      );
    });

    it("knows which live events touch the turns", () => {
      const event = (entityType: string, type = "changed") => ({
        entityType,
        entityId: "x",
        type,
      });
      expect(isSessionSpeakersEvent(event("speakers"))).toBe(true);
      expect(isSessionSpeakersEvent(event("speaking_turn"))).toBe(false);
      expect(isSessionSpeakersEvent(event("live", "live_changed"))).toBe(true);
      expect(isSessionSpeakersEvent(event("assembly", "poll"))).toBe(true);
      expect(isSessionSpeakersEvent(event("amendment"))).toBe(false);
    });
  });
});

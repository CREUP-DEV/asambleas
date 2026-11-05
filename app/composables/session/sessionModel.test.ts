import { describe, expect, it } from "vitest";
import type { AmendmentDto } from "~~/shared/types/api";
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
  isSessionAwaitingValidation,
  isSessionOpen,
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
      });
      expect(sessionValidationBreakdown([a1, hidden])).toEqual({
        toValidate: 0,
        inCorrection: 0,
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
      });
      expect(sessionFinalVoteBlockers([decided, a5])).toEqual({
        undecided: [],
        awaitingValidation: [],
      });
    });

    it("adds the ids a refused final vote reported", () => {
      const decided = { ...a2, status: "approved" as const };
      // "x9" is not loaded yet; a2 was decided since the server answered.
      expect(
        sessionFinalVoteBlockers([a1, decided, v1], ["v1", "a2", "x9", "a1"]),
      ).toEqual({ undecided: ["a1", "x9"], awaitingValidation: ["v1"] });
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
    expect(offer.lapse).toEqual(["a1", "a2", "a4"]);
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
});

import { describe, expect, it } from "vitest";
import type {
  DocumentSummaryDto,
  MeWorkAcceptanceDto,
  MeWorkAmendmentDto,
  MeWorkAssemblyRef,
  MeWorkDocumentDto,
  MeWorkDto,
  MeWorkNewsDto,
  MeWorkProponentDto,
  MeWorkReviewDto,
} from "~~/shared/types/api";
import {
  homeWorkAmendmentTask,
  homeWorkDocumentTask,
  homeWorkAmendmentQuery,
  homeWorkForAssembly,
  homeWorkNews,
  homeWorkNewsDeduped,
  homeWorkNewsItem,
  homeWorkNewsLink,
  homeWorkProponentCounts,
  homeWorkReviewPending,
  homeWorkReviewTotal,
  homeWorkTasks,
  homeWorkUpdates,
  isHomeWorkTransactionalCode,
} from "./-work";

const ago: MeWorkAssemblyRef = { id: "s1", slug: "80-ago", label: "80.ª AGO" };
const age: MeWorkAssemblyRef = { id: "s2", slug: "12-age", label: "12.ª AGE" };
const NOW = new Date("2026-11-05T12:00:00Z").getTime();

const doc = (
  id: string,
  over: Partial<DocumentSummaryDto> = {},
  assembly = ago,
): MeWorkDocumentDto => ({
  assembly,
  document: {
    id,
    slug: id,
    agendaItemId: "i1",
    kind: "executive_report",
    format: "structured",
    title: id.toUpperCase(),
    reference: null,
    status: "draft",
    proponent: null,
    coProponents: [],
    amendable: false,
    acceptedAmendments: "vote",
    voted: false,
    majority: "simple",
    amendmentCount: 0,
    window: { opensAt: null, closesAt: null, open: false },
    publishedAt: null,
    submittedAt: null,
    dueAt: null,
    hasContent: true,
    correctionNote: null,
    correctionRequestedAt: null,
    consolidated: false,
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  },
});

const amend = (
  id: string,
  over: Partial<MeWorkAmendmentDto["amendment"]> = {},
  assembly = ago,
): MeWorkAmendmentDto => ({
  assembly,
  document: { id: "d1", slug: "d1", title: "Resolución" },
  amendment: {
    id,
    code: id.toUpperCase(),
    status: "submitted",
    reviewState: "published",
    correctionNote: null,
    late: false,
    admission: "admitted",
    updatedAt: "2026-11-01T00:00:00Z",
    ...over,
  },
});

const upv = {
  id: "m-upv",
  acronym: "UPV",
  name: "UPV",
  kind: "asociado" as const,
};

/** Someone else's amendment unless a test says the member authored it. */
const news = (
  id: string,
  over: Partial<MeWorkNewsDto> = {},
): MeWorkNewsDto => ({
  id,
  assembly: ago,
  document: { id: "d1", slug: "d1", title: "Resolución" },
  amendment: { id: "e2", code: "CEUM 2" },
  ownAmendment: false,
  type: "position_changed",
  by: upv,
  value: "accept",
  at: "2026-11-04T10:00:00Z",
  ...over,
});

const review = (over: Partial<MeWorkReviewDto> = {}): MeWorkReviewDto => ({
  assembly: ago,
  documentsToValidate: 0,
  amendmentsToValidate: 0,
  amendmentsToPublish: 0,
  documentsOverdue: 0,
  ...over,
});

const presents = (
  id: string,
  over: Partial<MeWorkProponentDto> = {},
  assembly = ago,
): MeWorkProponentDto => ({
  assembly,
  document: { id, slug: id, title: id.toUpperCase() },
  positionsPending: 0,
  ...over,
});

const answer = (
  id: string,
  replaces: string[],
  assembly = ago,
): MeWorkAcceptanceDto => ({
  assembly,
  document: { id: "d1", slug: "d1", title: "Resolución" },
  transactional: { id, code: id.toUpperCase() },
  proposedBy: {
    id: "se",
    acronym: "SE",
    name: "Secretaría Ejecutiva",
    kind: "executive",
  },
  replaces: replaces.map((code) => ({ id: code.toLowerCase(), code })),
});

/** A work list with nothing in it but what a test adds. */
const empty = (over: Partial<MeWorkDto> = {}): MeWorkDto => ({
  documents: [],
  amendments: [],
  review: [],
  proponent: [],
  acceptances: [],
  news: [],
  ...over,
});

describe("home work", () => {
  it("classifies documents", () => {
    expect(homeWorkDocumentTask(doc("a", { hasContent: false }))).toBe(
      "document_prepare",
    );
    expect(homeWorkDocumentTask(doc("a"))).toBe("document_send");
    expect(
      homeWorkDocumentTask(
        doc("a", {
          correctionNote: "Falta el anexo",
          correctionRequestedAt: "2026-11-02T00:00:00Z",
        }),
      ),
    ).toBe("document_correction");
    // A correction without a note still counts as one.
    expect(
      homeWorkDocumentTask(
        doc("a", { correctionRequestedAt: "2026-11-02T00:00:00Z" }),
      ),
    ).toBe("document_correction");
    expect(homeWorkDocumentTask(doc("a", { status: "submitted" }))).toBe(null);
    expect(homeWorkDocumentTask(doc("a", { status: "published" }))).toBe(null);
  });

  it("classifies amendments", () => {
    expect(
      homeWorkAmendmentTask(
        amend("e", { status: "draft", reviewState: null, code: null }),
      ),
    ).toBe("amendment_draft");
    expect(
      homeWorkAmendmentTask(
        amend("e", {
          status: "draft",
          reviewState: "correction_requested",
          correctionNote: "Revisa el apartado 2",
        }),
      ),
    ).toBe("amendment_correction");
    expect(homeWorkAmendmentTask(amend("e"))).toBe(null);
  });

  it("orders tasks by urgency", () => {
    const work: MeWorkDto = empty({
      documents: [
        doc("later", { hasContent: false, dueAt: "2026-11-20T00:00:00Z" }),
        doc("nodue", { hasContent: true }),
        doc("soon", { hasContent: false, dueAt: "2026-11-08T00:00:00Z" }),
        doc("late", { hasContent: true, dueAt: "2026-11-01T00:00:00Z" }),
        doc("fix", {
          correctionNote: "Falta el anexo",
          correctionRequestedAt: "2026-11-02T00:00:00Z",
        }),
        doc("sent", { status: "submitted" }),
      ],
      amendments: [
        amend("draft", { status: "draft", reviewState: null }),
        amend("fixme", {
          status: "draft",
          reviewState: "correction_requested",
          correctionNote: "Revisa el apartado 2",
        }),
        amend("waiting", { reviewState: "pending_validation" }),
      ],
      proponent: [
        presents("positions", { positionsPending: 3 }),
        presents("done"),
        presents("another", { positionsPending: 1 }),
      ],
      acceptances: [answer("t2", ["CEUM 2"])],
    });
    const tasks = homeWorkTasks(work, NOW);
    expect(tasks.map((task) => task.key)).toEqual([
      "document-fix",
      "amendment-fixme",
      // A transactional waiting for the user holds up their amendment.
      "acceptance-t2",
      "proponent-another",
      "proponent-positions",
      "document-late",
      "document-soon",
      "document-later",
      "document-nodue",
      "amendment-draft",
    ]);
    const byKey = new Map(tasks.map((task) => [task.key, task]));
    expect(byKey.get("document-late")).toMatchObject({
      kind: "document_send",
      overdue: true,
      target: "edit",
    });
    expect(byKey.get("document-soon")).toMatchObject({
      kind: "document_prepare",
      overdue: false,
    });
    expect(byKey.get("document-fix")?.note).toBe("Falta el anexo");
    expect(byKey.get("amendment-fixme")).toMatchObject({
      kind: "amendment_correction",
      note: "Revisa el apartado 2",
      target: "document",
      amendment: { id: "fixme", code: "FIXME" },
    });
    // Notes are only carried by corrections.
    expect(byKey.get("document-nodue")?.note).toBe(null);
    expect(byKey.get("proponent-another")).toMatchObject({
      kind: "proponent_review",
      target: "review",
      amendment: null,
      counts: { positions: 1 },
      document: { id: "another", slug: "another", title: "ANOTHER" },
    });
    expect(byKey.get("document-late")?.counts).toBe(null);
    // Answered in the document workspace, with the transactional open.
    expect(byKey.get("acceptance-t2")).toMatchObject({
      kind: "transactional_answer",
      target: "document",
      amendment: { id: "t2", code: "T2" },
      replaces: [{ id: "ceum 2", code: "CEUM 2" }],
      proposedBy: "SE",
      document: { id: "d1", slug: "d1", title: "Resolución" },
    });
    expect(homeWorkAmendmentQuery(byKey.get("acceptance-t2")!.amendment)).toBe(
      "?enmienda=t2",
    );
  });

  it("counts what waits for the presenter", () => {
    expect(homeWorkProponentCounts(presents("a"))).toBe(null);
    expect(
      homeWorkProponentCounts(presents("a", { positionsPending: 2 })),
    ).toEqual({ positions: 2 });
    expect(
      homeWorkProponentCounts(presents("a", { positionsPending: -1 })),
    ).toBe(null);
  });

  it("says where the rest stands", () => {
    const work: MeWorkDto = empty({
      documents: [
        doc("pub", { status: "published" }),
        doc("sent", { status: "submitted" }),
        doc("gone", { status: "withdrawn" }),
        doc("todo", { hasContent: false }),
      ],
      amendments: [
        amend("e3", { reviewState: "published" }),
        amend("e1", { reviewState: "pending_validation" }),
        amend("e2", { reviewState: "validated" }),
        amend("e4", { status: "draft", reviewState: null }),
        amend("e5", { status: "inadmissible", reviewState: "published" }),
        // Late, checked by the Secretaría: the assembly decides first.
        amend("e6", { late: true, admission: "pending" }),
        // A transactional the user proposed, waiting for the main authors.
        amend("t1", { reviewState: "pending_authors", admission: "pending" }),
        // Late but still with the Secretaría: that comes first.
        amend("e7", {
          late: true,
          admission: "pending",
          reviewState: "pending_validation",
        }),
      ],
      proponent: [presents("pub")],
    });
    expect(
      homeWorkUpdates(work).map((update) => [update.key, update.kind]),
    ).toEqual([
      // Same step: by document title ("Resolución" before "SENT").
      ["amendment-e1", "amendment_review"],
      ["amendment-e7", "amendment_review"],
      ["amendment-t1", "amendment_authors"],
      ["document-sent", "document_review"],
      ["amendment-e2", "amendment_validated"],
      ["amendment-e6", "amendment_late"],
      ["document-pub", "document_published"],
      ["amendment-e3", "amendment_published"],
      ["amendment-e5", "amendment_other"],
    ]);
    // With amendments to answer, the published document is a task instead.
    expect(
      homeWorkUpdates({
        ...work,
        proponent: [presents("pub", { positionsPending: 4 })],
      }).map((update) => update.key),
    ).not.toContain("document-pub");
  });

  it("summarises the Secretaría's pending review", () => {
    const busy = review({ documentsToValidate: 2, documentsOverdue: 1 });
    const quiet = review({ assembly: age });
    expect(homeWorkReviewTotal(busy)).toBe(3);
    expect(homeWorkReviewTotal(quiet)).toBe(0);
    expect(homeWorkReviewPending([busy, quiet])).toEqual([busy]);
  });

  it("filters by assembly", () => {
    const work: MeWorkDto = {
      documents: [doc("a"), doc("b", {}, age)],
      amendments: [amend("e", {}, age)],
      review: [review(), review({ assembly: age, amendmentsToPublish: 1 })],
      proponent: [
        presents("p1", { positionsPending: 1 }),
        presents("p2", { positionsPending: 1 }, age),
      ],
      acceptances: [answer("t1", ["CEUM 1"]), answer("t9", ["CEUM 9"], age)],
      news: [news("n1"), news("n2", { assembly: age })],
    };
    const ours = homeWorkForAssembly(work, "s1");
    expect(ours.documents.map((entry) => entry.document.id)).toEqual(["a"]);
    expect(ours.amendments).toEqual([]);
    expect(ours.review.map((entry) => entry.assembly.id)).toEqual(["s1"]);
    expect(ours.proponent.map((entry) => entry.document.id)).toEqual(["p1"]);
    expect(ours.acceptances.map((entry) => entry.transactional.id)).toEqual([
      "t1",
    ]);
    expect(ours.news.map((entry) => entry.id)).toEqual(["n1"]);
  });

  describe("news", () => {
    /** The member authored the amendment the news is about. */
    const mine = { ownAmendment: true };
    const words = (item: ReturnType<typeof homeWorkNewsItem>) => ({
      sentence: item.sentence.key,
      who: item.who
        ? "name" in item.who
          ? item.who.name
          : [item.who.key, item.who.params]
        : null,
      phrase: item.phrase ? [item.phrase.key, item.phrase.params] : null,
      tone: item.tone,
    });

    it("names the Admin who did it while acting as the account", () => {
      expect(homeWorkNewsItem(news("n")).impersonatedBy).toBeNull();
      expect(
        homeWorkNewsItem(
          news("n", { impersonatedBy: { id: "a".repeat(32), name: "Admin" } }),
        ).impersonatedBy,
      ).toBe("Admin");
    });

    it("says what the main presenter answered", () => {
      expect(words(homeWorkNewsItem(news("n", mine)))).toEqual({
        sentence: "home.news.position.accept",
        who: ["home.news.who.mainPresenter", { member: "UPV" }],
        // The amendment is the user's own: "tu enmienda CEUM 2".
        phrase: ["home.news.phrase.yourAmendment", { code: "CEUM 2" }],
        tone: "success",
      });
      // Someone else's, in a document the member co-presents: neutral.
      expect(
        words(homeWorkNewsItem(news("n", { value: "reject" }))),
      ).toMatchObject({
        sentence: "home.news.position.reject",
        phrase: ["home.news.phrase.amendment", { code: "CEUM 2" }],
        tone: "error",
      });
      // Recorded by the Mesa before answers named the main presenter, or an
      // unknown answer.
      expect(
        words(homeWorkNewsItem(news("n", { ...mine, by: null, value: "x" }))),
      ).toMatchObject({
        sentence: "home.news.position.pending",
        who: ["home.news.who.mainPresenterUnknown", {}],
      });
    });

    it("leads co-presenters to the review of the main presenter's answers", () => {
      // A co-presenter reads the answer to someone else's amendment in the
      // read-only review, on that amendment.
      const answer = homeWorkNewsItem(news("n"));
      expect(answer.target).toBe("review");
      expect(homeWorkNewsLink(answer)).toBe("/revisar?enmienda=e2");
      // The answer to the member's own amendment opens the document on it.
      const own = homeWorkNewsItem(news("n", mine));
      expect(own.target).toBe("document");
      expect(homeWorkNewsLink(own)).toBe("?enmienda=e2");
      // Everything else opens the document, with the amendment if any.
      const voted = homeWorkNewsItem(
        news("n", { ...mine, type: "amendment_rejected", value: null }),
      );
      expect(voted.target).toBe("document");
      expect(
        homeWorkNewsLink(
          homeWorkNewsItem(
            news("n", {
              type: "document_published",
              amendment: null,
              value: null,
            }),
          ),
        ),
      ).toBe("");
    });

    it("says what a main author answered to the member's transactional", () => {
      const rejected = news("n", {
        ...mine,
        type: "acceptance_recorded",
        amendment: { id: "t2", code: "T2" },
        by: { ...upv, acronym: "CAUB" },
        value: "rejected",
      });
      expect(words(homeWorkNewsItem(rejected))).toEqual({
        sentence: "home.news.acceptance.rejected",
        who: "CAUB",
        phrase: ["home.news.phrase.yourTransactional", { code: "T2" }],
        tone: "error",
      });
      expect(
        words(homeWorkNewsItem({ ...rejected, value: "accepted" })),
      ).toMatchObject({
        sentence: "home.news.acceptance.accepted",
        phrase: ["home.news.phrase.yourTransactional", { code: "T2" }],
        tone: "success",
      });
      expect(
        homeWorkNewsItem({ ...rejected, value: "pending" }).sentence.key,
      ).toBe("home.news.acceptance.pending");
      // Unknown party: still a sentence.
      expect(homeWorkNewsItem({ ...rejected, by: null }).who).toEqual({
        key: "home.news.who.mainAuthorUnknown",
        params: {},
      });
    });

    it("says what a transactional over the member's amendment means for it", () => {
      // "CAUB rechazó la transaccional T2: sigue tu enmienda."
      const rejected = news("n", {
        type: "acceptance_recorded",
        amendment: { id: "t2", code: "T2" },
        by: { ...upv, acronym: "CAUB" },
        value: "rejected",
      });
      expect(words(homeWorkNewsItem(rejected))).toEqual({
        sentence: "home.news.acceptance.rejectedOverYours",
        who: "CAUB",
        phrase: ["home.news.phrase.transactional", { code: "T2" }],
        // The member's amendment carries on: not bad news for it.
        tone: "neutral",
      });
      expect(
        words(homeWorkNewsItem({ ...rejected, value: "accepted" })),
      ).toMatchObject({
        sentence: "home.news.acceptance.acceptedOverYours",
        phrase: ["home.news.phrase.transactional", { code: "T2" }],
        tone: "neutral",
      });
      // Not a position: it opens the document on the transactional.
      expect(homeWorkNewsItem(rejected).target).toBe("document");
    });

    it("names the main presenter who incorporated an amendment", () => {
      // "UPV, proponente principal, aceptó tu enmienda CEUM 2: ya está en
      // el texto sin votación."
      expect(
        words(
          homeWorkNewsItem(
            news("n", {
              ...mine,
              type: "amendment_approved",
              value: "proponent",
            }),
          ),
        ),
      ).toEqual({
        sentence: "home.news.amendment.incorporatedBy",
        who: ["home.news.who.mainPresenter", { member: "UPV" }],
        phrase: ["home.news.phrase.yourAmendment", { code: "CEUM 2" }],
        tone: "success",
      });
    });

    it("says plainly why a transactional was closed", () => {
      const closed = (value: string | null, own: boolean) =>
        homeWorkNewsItem(
          news("n", {
            type: "amendment_withdrawn",
            amendment: { id: "t2", code: "T2" },
            ownAmendment: own,
            by: null,
            value,
          }),
        );
      // Closed on its own: CEUM 2, which it groups, was settled first (the
      // value names it). The member's own transactional, or one over its
      // amendment (a party).
      expect(words(closed("CEUM 2", true))).toEqual({
        sentence: "home.news.amendment.closedBy",
        who: null,
        phrase: ["home.news.phrase.yourTransactional", { code: "T2" }],
        tone: "neutral",
      });
      expect(closed("CEUM 2", true).sentence.params).toEqual({
        code: "CEUM 2",
      });
      expect(words(closed("CEUM 2", false))).toMatchObject({
        sentence: "home.news.amendment.closedBy",
        phrase: ["home.news.phrase.transactional", { code: "T2" }],
      });
      // Withdrawn by whoever proposed it or by the Mesa: no value.
      expect(closed(null, true).sentence).toEqual({
        key: "home.news.amendment.withdrawn",
        params: {},
      });
      // Left behind because another transactional replaced what it groups.
      expect(
        homeWorkNewsItem(
          news("n", {
            type: "amendment_lapsed",
            amendment: { id: "t1", code: "T1" },
            by: null,
            value: "T2",
          }),
        ),
      ).toMatchObject({
        sentence: {
          key: "home.news.amendment.lapsedBy",
          params: { code: "T2" },
        },
        phrase: {
          key: "home.news.phrase.transactional",
          params: { code: "T1" },
        },
      });
    });

    it("says one decision once", () => {
      const at = "2026-11-04T10:00:00Z";
      const t2 = { id: "t2", code: "T2" };
      // CAUB rejects the member's transactional: it is closed (withdrawn)
      // in the same transaction.
      const rejection = [
        news("r1", {
          ...mine,
          type: "acceptance_recorded",
          amendment: t2,
          by: { ...upv, acronym: "CAUB" },
          value: "rejected",
          at,
        }),
        news("r2", {
          ...mine,
          type: "amendment_withdrawn",
          amendment: t2,
          by: null,
          value: null,
          at: "2026-11-04T10:00:00.000Z",
        }),
      ];
      expect(homeWorkNewsDeduped(rejection).map((x) => x.id)).toEqual(["r1"]);
      // Withdrawn later by whoever proposed it: both stay.
      expect(
        homeWorkNewsDeduped([
          rejection[0]!,
          { ...rejection[1]!, at: "2026-11-04T11:00:00Z" },
        ]).map((x) => x.id),
      ).toEqual(["r1", "r2"]);
      // The main presenter accepts, which incorporates it: the
      // incorporation names who, the bare answer goes.
      const accepted = [
        news("p1", { ...mine, at }),
        news("p2", {
          ...mine,
          type: "amendment_approved",
          value: "proponent",
          at,
        }),
      ];
      expect(homeWorkNewsDeduped(accepted).map((x) => x.id)).toEqual(["p2"]);
      // Takes it out again: the answer says so, the reopening goes.
      const changed = [
        news("c1", { ...mine, value: "reject", at }),
        news("c2", { ...mine, type: "amendment_reopened", value: null, at }),
      ];
      expect(homeWorkNewsDeduped(changed).map((x) => x.id)).toEqual(["c1"]);
      // Another amendment at the same time is another decision: the
      // amendment settled and the transactional it closed on its own.
      expect(
        homeWorkNewsDeduped([
          rejection[0]!,
          {
            ...rejection[1]!,
            amendment: { id: "t3", code: "T3" },
            value: "CEUM 2",
          },
        ]).map((x) => x.id),
      ).toEqual(["r1", "r2"]);
      expect(
        homeWorkNews(empty({ news: [...rejection, ...accepted] })).map(
          (x) => x.key,
        ),
      ).toEqual(["p2", "r1"]);
    });

    it("tells transactional codes apart", () => {
      expect(isHomeWorkTransactionalCode("T2")).toBe(true);
      expect(isHomeWorkTransactionalCode("T12")).toBe(true);
      expect(isHomeWorkTransactionalCode("CEUM 2")).toBe(false);
      expect(isHomeWorkTransactionalCode("TUE 3")).toBe(false);
      expect(isHomeWorkTransactionalCode(null)).toBe(false);
    });

    it("words decisions of the Secretaría and the assembly", () => {
      const key = (over: Partial<MeWorkNewsDto>) =>
        homeWorkNewsItem(news("n", { ...mine, by: null, ...over })).sentence
          .key;
      expect(key({ type: "amendment_approved", value: "proponent" })).toBe(
        "home.news.amendment.incorporated",
      );
      expect(key({ type: "amendment_approved", value: "vote" })).toBe(
        "home.news.amendment.approved",
      );
      expect(key({ type: "amendment_validated", value: null })).toBe(
        "home.news.amendment.validated",
      );
      expect(key({ type: "amendment_validated", value: "admitted" })).toBe(
        "home.news.amendment.validated",
      );
      // Late: validated, but the assembly still decides whether to treat it.
      expect(key({ type: "amendment_validated", value: "pending" })).toBe(
        "home.news.amendment.validatedLate",
      );
      expect(key({ type: "amendment_admitted", value: null })).toBe(
        "home.news.amendment.admitted",
      );
      expect(key({ type: "amendment_transacted", value: null })).toBe(
        "home.news.amendment.transacted",
      );
      // Named after the transactional that replaced it.
      const transacted = homeWorkNewsItem(
        news("n", {
          ...mine,
          type: "amendment_transacted",
          value: "T2",
          by: null,
        }),
      );
      expect(transacted.sentence).toEqual({
        key: "home.news.amendment.transactedBy",
        params: { code: "T2" },
      });
      expect(transacted.phrase?.key).toBe("home.news.phrase.yourAmendment");
      // A transactional of the member that another one got ahead of.
      const behind = homeWorkNewsItem(
        news("n", {
          ...mine,
          type: "amendment_lapsed",
          amendment: { id: "t1", code: "T1" },
          value: "T2",
          by: null,
        }),
      );
      expect(behind.sentence).toEqual({
        key: "home.news.amendment.lapsedBy",
        params: { code: "T2" },
      });
      expect(behind.phrase?.key).toBe("home.news.phrase.yourTransactional");
      expect(key({ type: "amendment_lapsed", value: null })).toBe(
        "home.news.amendment.lapsed",
      );
      expect(
        key({ type: "document_voted", value: "rejected", amendment: null }),
      ).toBe("home.news.document.rejected");
      expect(
        key({
          type: "document_status_changed",
          value: "postponed",
          amendment: null,
        }),
      ).toBe("home.work.updates.document_postponed");
      // Something new: a general sentence, never an unknown key.
      expect(key({ type: "something_else" })).toBe("home.news.amendment.other");
      expect(key({ type: "something_else", amendment: null })).toBe(
        "home.news.document.other",
      );
      expect(
        homeWorkNewsItem(news("n", { amendment: { id: "x", code: null } }))
          .phrase?.key,
      ).toBe("home.news.phrase.someAmendment");
      // A document's news names no amendment, even if flagged as own.
      expect(
        homeWorkNewsItem(
          news("n", { ...mine, type: "document_published", amendment: null }),
        ).phrase,
      ).toBe(null);
    });

    it("lists the latest first and says whose amendment it is as the server does", () => {
      const work = empty({
        news: [
          news("old", { at: "2026-11-01T10:00:00Z" }),
          news("new", {
            ...mine,
            at: "2026-11-05T09:00:00Z",
            amendment: { id: "e1", code: "E1" },
          }),
          // Decided and gone from the work list: still the member's.
          news("voted", {
            ...mine,
            type: "amendment_rejected",
            by: null,
            value: null,
            at: "2026-11-03T10:00:00Z",
          }),
        ],
      });
      const items = homeWorkNews(work);
      expect(items.map((item) => item.key)).toEqual(["new", "voted", "old"]);
      expect(items.map((item) => item.phrase?.key)).toEqual([
        "home.news.phrase.yourAmendment",
        "home.news.phrase.yourAmendment",
        "home.news.phrase.amendment",
      ]);
      // Nothing in the work list makes someone else's amendment "tu
      // enmienda": only the server's flag does.
      expect(
        homeWorkNews({ ...work, amendments: [amend("e2")] }).map(
          (item) => item.phrase?.key,
        ),
      ).toEqual([
        "home.news.phrase.yourAmendment",
        "home.news.phrase.yourAmendment",
        "home.news.phrase.amendment",
      ]);
    });
  });

  it("opens the amendment a task or update is about", () => {
    expect(homeWorkAmendmentQuery(null)).toBe("");
    expect(homeWorkAmendmentQuery({ id: "abc123" })).toBe("?enmienda=abc123");
    expect(homeWorkAmendmentQuery({ id: "a b&c" })).toBe("?enmienda=a%20b%26c");
  });
});

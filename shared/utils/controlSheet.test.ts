import { describe, expect, it } from "vitest";
import {
  amendmentTreatedInSession,
  controlSheetRows,
  isUnanimousVote,
  itemDocumentsOutcome,
  itemHasVotedDocuments,
  itemTakesOwnVote,
  itemOutcome,
  latestItemVote,
  ownVoteItemIds,
  sheetSpeakers,
  voteSheetResult,
  type SheetDocument,
  type SheetItemVote,
  type SheetVote,
} from "./controlSheet";

const vote = (over: Partial<SheetVote> = {}): SheetVote => ({
  method: "show_of_hands",
  result: "approved",
  inFavor: 20,
  against: 3,
  abstentions: 1,
  blank: 0,
  invalid: 0,
  ...over,
});

const doc = (over: Partial<SheetDocument> = {}): SheetDocument => ({
  id: "d1",
  agendaItemId: "i1",
  status: "published",
  voted: true,
  finalVote: null,
  ...over,
});

describe("isUnanimousVote", () => {
  it("is a counted vote with only votes in favour", () => {
    expect(
      isUnanimousVote(vote({ against: 0, abstentions: 0, inFavor: 30 })),
    ).toBe(true);
    expect(isUnanimousVote(vote())).toBe(false);
    // Blank ballots are no vote, as on the PDF approval line.
    expect(
      isUnanimousVote(vote({ against: 0, abstentions: 0, blank: 1 })),
    ).toBe(true);
  });

  it("never reads an assent or a rejection as unanimity", () => {
    expect(
      isUnanimousVote(
        vote({ method: "assent", inFavor: 0, against: 0, abstentions: 0 }),
      ),
    ).toBe(false);
    expect(
      isUnanimousVote(
        vote({ result: "rejected", inFavor: 1, against: 0, abstentions: 0 }),
      ),
    ).toBe(false);
  });

  it("reads an assent unanimous once nobody objected", () => {
    const assent = vote({
      method: "assent",
      inFavor: 0,
      against: 0,
      abstentions: 0,
      unanimous: true,
    });
    expect(isUnanimousVote(assent)).toBe(true);
    expect(voteSheetResult(assent)).toBe("approved_unanimous");
  });

  it("words the result", () => {
    expect(voteSheetResult(vote())).toBe("approved");
    expect(voteSheetResult(vote({ result: "rejected" }))).toBe("rejected");
    expect(voteSheetResult(vote({ against: 0, abstentions: 0 }))).toBe(
      "approved_unanimous",
    );
  });
});

describe("itemDocumentsOutcome", () => {
  it("says nothing of an item without documents", () => {
    expect(itemDocumentsOutcome([])).toEqual({
      result: null,
      treated: false,
      byVote: false,
    });
  });

  it("waits for every voted document's final vote", () => {
    expect(
      itemDocumentsOutcome([
        doc({ finalVote: vote() }),
        doc({ id: "d2", finalVote: null }),
      ]),
    ).toEqual({ result: null, treated: false, byVote: false });
  });

  it("reads the votes once all are in", () => {
    expect(
      itemDocumentsOutcome([
        doc({ finalVote: vote() }),
        doc({ id: "d2", finalVote: vote({ against: 0, abstentions: 0 }) }),
      ]),
    ).toEqual({ result: "approved", treated: true, byVote: true });
    expect(
      itemDocumentsOutcome([
        doc({ finalVote: vote() }),
        doc({ id: "d2", finalVote: vote({ result: "rejected" }) }),
      ]),
    ).toEqual({ result: "mixed", treated: true, byVote: true });
    expect(
      itemDocumentsOutcome([doc({ finalVote: vote({ result: "rejected" }) })]),
    ).toEqual({ result: "rejected", treated: true, byVote: true });
  });

  it("leaves withdrawn and postponed documents out of the votes", () => {
    expect(
      itemDocumentsOutcome([
        doc({ finalVote: vote() }),
        doc({ id: "d2", status: "withdrawn" }),
      ]),
    ).toEqual({ result: "approved", treated: true, byVote: true });
    expect(itemDocumentsOutcome([doc({ status: "withdrawn" })])).toEqual({
      result: "withdrawn",
      treated: true,
      byVote: false,
    });
    expect(itemDocumentsOutcome([doc({ status: "postponed" })])).toEqual({
      result: "postponed",
      treated: true,
      byVote: false,
    });
  });

  it("reads a report as not applicable, still to be marked", () => {
    expect(itemDocumentsOutcome([doc({ voted: false })])).toEqual({
      result: "not_applicable",
      treated: false,
      byVote: false,
    });
  });
});

describe("itemOutcome", () => {
  it("keeps the votes over anything noted by hand", () => {
    expect(
      itemOutcome([doc({ finalVote: vote() })], {
        manualResult: "lapsed",
        treated: false,
      }),
    ).toEqual({ result: "approved", treated: true, byVote: true });
  });

  it("lets a note by hand replace «No aplica» and count as treated", () => {
    expect(
      itemOutcome([doc({ voted: false })], {
        manualResult: "lapsed",
        treated: false,
      }),
    ).toEqual({ result: "lapsed", treated: true, byVote: false });
    expect(
      itemOutcome([doc({ voted: false })], {
        manualResult: "not_applicable",
        treated: false,
      }),
    ).toEqual({ result: "not_applicable", treated: false, byVote: false });
  });

  it("takes the Mesa's treated mark", () => {
    expect(itemOutcome([], { manualResult: null, treated: true })).toEqual({
      result: null,
      treated: true,
      byVote: false,
    });
  });
});

describe("the item's own vote", () => {
  const itemVote = (over: Partial<SheetItemVote> = {}): SheetItemVote => ({
    ...vote(),
    id: "v1",
    recordedAt: "2026-11-20T10:00:00.000Z",
    voidedAt: null,
    ...over,
  });
  const report = doc({ voted: false });

  it("reads «Pendiente» for a report item that is voted, until its vote", () => {
    expect(itemDocumentsOutcome([report], { voted: true, votes: [] })).toEqual({
      result: null,
      treated: false,
      byVote: false,
    });
    expect(itemDocumentsOutcome([report], { voted: false, votes: [] })).toEqual(
      { result: "not_applicable", treated: false, byVote: false },
    );
  });

  it("takes the latest vote in force, whatever the switch says", () => {
    const own = {
      voted: false,
      votes: [
        itemVote({ id: "a", result: "rejected" }),
        itemVote({
          id: "b",
          recordedAt: "2026-11-20T11:00:00.000Z",
          result: "approved",
        }),
        itemVote({
          id: "c",
          recordedAt: "2026-11-20T12:00:00.000Z",
          result: "rejected",
          voidedAt: "2026-11-20T12:05:00.000Z",
        }),
      ],
    };
    expect(latestItemVote(own.votes)?.id).toBe("b");
    expect(itemDocumentsOutcome([], own)).toEqual({
      result: "approved",
      treated: true,
      byVote: true,
    });
    expect(itemDocumentsOutcome([report], own).result).toBe("approved");
    // A vote by hand never replaces it.
    expect(
      itemOutcome([report], { manualResult: "lapsed", treated: false }, own)
        .result,
    ).toBe("approved");
  });

  it("ignores it while a document of the item is voted", () => {
    const own = { voted: true, votes: [itemVote()] };
    expect(itemDocumentsOutcome([doc()], own)).toEqual({
      result: null,
      treated: false,
      byVote: false,
    });
    expect(itemHasVotedDocuments([doc()])).toBe(true);
    expect(itemHasVotedDocuments([doc({ status: "draft" })])).toBe(false);
    expect(itemHasVotedDocuments([doc({ status: "withdrawn" })])).toBe(false);
    expect(itemHasVotedDocuments([report])).toBe(false);
  });

  it("takes no vote of its own where members present", () => {
    expect(itemTakesOwnVote({ acceptsSubmissions: true }, [])).toBe(false);
    expect(itemTakesOwnVote({ acceptsSubmissions: false }, [report])).toBe(
      true,
    );
    expect(itemTakesOwnVote({ acceptsSubmissions: false }, [doc()])).toBe(
      false,
    );
  });

  it("lists the items voted by themselves", () => {
    expect([
      ...ownVoteItemIds(
        [
          { id: "i1", voted: true },
          { id: "i2", voted: false },
          { id: "i3", voted: false },
        ],
        [
          { subjectId: "i2", voidedAt: null },
          { subjectId: "i3", voidedAt: "2026-11-20T12:05:00.000Z" },
        ],
      ),
    ]).toEqual(["i1", "i2"]);
  });
});

describe("amendmentTreatedInSession", () => {
  const start = "2026-11-20T09:00:00.000Z";
  it("counts what the Mesa settled once the session began", () => {
    expect(
      amendmentTreatedInSession(
        {
          status: "rejected",
          approvalMethod: null,
          decidedAt: "2026-11-20T10:00:00.000Z",
        },
        start,
      ),
    ).toBe(true);
    expect(
      amendmentTreatedInSession(
        {
          status: "withdrawn",
          approvalMethod: null,
          decidedAt: "2026-11-19T10:00:00.000Z",
        },
        start,
      ),
    ).toBe(false);
  });

  it("leaves out incorporations, undecided ones and the time before", () => {
    expect(
      amendmentTreatedInSession(
        {
          status: "approved",
          approvalMethod: "proponent",
          decidedAt: "2026-11-20T10:00:00.000Z",
        },
        start,
      ),
    ).toBe(false);
    expect(
      amendmentTreatedInSession(
        { status: "submitted", approvalMethod: null, decidedAt: null },
        start,
      ),
    ).toBe(false);
    expect(
      amendmentTreatedInSession(
        {
          status: "approved",
          approvalMethod: "vote",
          decidedAt: "2026-11-20T10:00:00.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("controlSheetRows", () => {
  const items = [
    { id: "1", parentId: null },
    { id: "2", parentId: null },
    { id: "2.1", parentId: "2" },
    { id: "2.2", parentId: "2" },
    { id: "3", parentId: null },
  ];

  it("lists items with documents under their parents as headings", () => {
    expect(
      controlSheetRows(items, [{ agendaItemId: "2.2" }]).map((row) => [
        row.item.id,
        row.kind,
      ]),
    ).toEqual([
      ["2", "heading"],
      ["2.2", "item"],
    ]);
  });

  it("adds the items listed by hand", () => {
    expect(
      controlSheetRows(items, [], new Set(["1", "2"])).map((row) => [
        row.item.id,
        row.kind,
      ]),
    ).toEqual([
      ["1", "item"],
      ["2", "item"],
    ]);
  });
});

describe("sheetSpeakers", () => {
  it("lists each speaker once, with times and names", () => {
    const ceuam = { id: "m1", acronym: "CEUAM" };
    expect(
      sheetSpeakers([
        { member: ceuam, speaker: "Ana" },
        { member: { id: "m2", acronym: "CEUIB" }, speaker: null },
        { member: ceuam, speaker: "Luis" },
        { member: null, speaker: "Invitada" },
        { member: null, speaker: " " },
      ]),
    ).toEqual([
      { label: "CEUAM", names: ["Ana", "Luis"], times: 2 },
      { label: "CEUIB", names: [], times: 1 },
      { label: "Invitada", names: [], times: 1 },
    ]);
  });
});

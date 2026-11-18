import { describe, expect, it } from "vitest";
import type {
  AgendaItemDto,
  AmendmentDto,
  ControlSheetDto,
  ControlSheetItemRowDto,
  DocumentSummaryDto,
  VoteDto,
} from "~~/shared/types/api";
import {
  affectsControlSheet,
  affectsLiveDebate,
  amendedDocuments,
  amendmentSheetKind,
  amendmentTreatedControl,
  buildAmendmentRows,
  newerPosition,
  buildGeneralRows,
  documentAgendaTrail,
  itemTreatedControl,
  rowVoteEntries,
  staleSheetRow,
  type AmendmentSheetRow,
} from "./-model";

const item = (over: Partial<AgendaItemDto>): AgendaItemDto =>
  ({
    id: "i",
    slug: "i",
    parentId: null,
    title: "Punto",
    titleHidden: false,
    unlisted: false,
    description: null,
    order: 0,
    acceptsSubmissions: false,
    submissionKinds: [],
    voted: false,
    ...over,
  }) as AgendaItemDto;

const document = (over: Partial<DocumentSummaryDto>): DocumentSummaryDto =>
  ({
    id: "d",
    slug: "d",
    agendaItemId: "i",
    title: "Documento",
    reference: null,
    status: "published",
    voted: true,
    ...over,
  }) as DocumentSummaryDto;

const vote = (over: Partial<VoteDto> = {}): VoteDto => ({
  id: "v",
  subjectType: "document",
  subjectId: "d",
  method: "show_of_hands",
  inFavor: 20,
  against: 2,
  abstentions: 1,
  blank: 0,
  invalid: 0,
  present: null,
  majority: "simple",
  result: "approved",
  note: null,
  question: null,
  unanimous: false,
  recordedAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  voidedAt: null,
  ...over,
});

const sheet = (over: Partial<ControlSheetDto> = {}): ControlSheetDto => ({
  sessionStartedAt: null,
  documents: [],
  turns: [],
  itemRows: [],
  amendmentRows: [],
  positions: [],
  itemVotes: [],
  can: { edit: true, moderate: false },
  ...over,
});

describe("buildGeneralRows", () => {
  const items = [
    item({ id: "1", order: 0, title: "Mesa" }),
    item({ id: "2", order: 1, title: "Resoluciones" }),
    item({ id: "2a", parentId: "2", order: 0, title: "RES 1" }),
    item({ id: "2b", parentId: "2", order: 1, title: "RES 2" }),
  ];

  it("numbers over the whole agenda and shows parents as headings", () => {
    const rows = buildGeneralRows(
      items,
      [document({ id: "d1", agendaItemId: "2b" })],
      sheet({
        documents: [
          { id: "d1", finalVote: vote(), amendments: 0, undecided: 0 },
        ],
      }),
      "2b",
    );
    expect(rows.map((row) => [row.number, row.kind, row.live])).toEqual([
      ["2", "heading", false],
      ["2.2", "item", true],
    ]);
    expect(rows[1]!.outcome).toEqual({
      result: "approved",
      treated: true,
      byVote: true,
    });
  });

  it("leaves drafts out and groups the speakers of each item", () => {
    const rows = buildGeneralRows(
      items,
      [
        document({ id: "d1", agendaItemId: "1", status: "draft" }),
        document({ id: "d2", agendaItemId: "2a", voted: false }),
      ],
      sheet({
        turns: [
          {
            id: "t1",
            member: {
              id: "m1",
              acronym: "CEUAM",
              name: "CEUAM",
              kind: "asociado",
            },
            speaker: "Ana",
            agendaItemId: "2a",
            status: "done",
            position: 0,
            startedAt: null,
            endedAt: null,
            limitSeconds: null,
            priority: false,
            createdAt: "2026-11-20T10:00:00.000Z",
            updatedAt: "2026-11-20T10:00:00.000Z",
          },
        ],
      }),
      null,
    );
    expect(rows.map((row) => row.id)).toEqual(["2", "2a"]);
    expect(rows[1]!.speakers).toEqual([
      { label: "CEUAM", names: ["Ana"], times: 1 },
    ]);
    expect(rows[1]!.outcome.result).toBe("not_applicable");
  });
});

describe("listed items", () => {
  it("adds items without documents the sheet lists, with their notes", () => {
    const rows = buildGeneralRows(
      [item({ id: "1", order: 0 }), item({ id: "2", order: 1 })],
      [],
      sheet({
        itemRows: [
          {
            id: "r1",
            agendaItemId: "1",
            listed: true,
            listedUpdatedAt: "2026-11-20T10:00:00.000Z",
            manualResult: "lapsed",
            resultUpdatedAt: "2026-11-20T10:00:00.000Z",
            treated: null,
            progressUpdatedAt: null,
            observations: "",
            observationsEdited: null,
            observationsUpdatedAt: null,
          },
        ],
      }),
      null,
    );
    expect(rows.map((row) => [row.id, row.outcome.result])).toEqual([
      ["1", "lapsed"],
    ]);
    expect(rows[0]!.outcome.treated).toBe(true);
  });
});

describe("item votes", () => {
  const itemVote = (over: Partial<VoteDto> = {}) =>
    vote({
      subjectType: "agenda_item",
      subjectId: "1",
      question: "Ratificación",
      ...over,
    });

  it("lists an item by «Se vota el punto», «Pendiente» until its vote", () => {
    const rows = buildGeneralRows(
      [item({ id: "1", voted: true }), item({ id: "2", order: 1 })],
      [],
      sheet(),
      null,
    );
    expect(rows.map((row) => row.id)).toEqual(["1"]);
    expect(rows[0]).toMatchObject({
      voted: true,
      ownListed: true,
      takesOwnVote: true,
      votedThroughDocuments: false,
      outcome: { result: null, treated: false, byVote: false },
      autoTreated: false,
    });
  });

  it("reads the public's title flag, hidden when the agenda does not say", () => {
    const rows = buildGeneralRows(
      [
        item({ id: "1", voted: true, publicTitleHidden: false }),
        item({ id: "2", order: 1, voted: true, publicTitleHidden: true }),
        // An agenda from before the flag: never taken as readable.
        item({ id: "3", order: 2, voted: true }),
      ],
      [],
      sheet(),
      null,
    );
    expect(rows.map((row) => [row.id, row.publicTitleHidden])).toEqual([
      ["1", false],
      ["2", true],
      ["3", true],
    ]);
  });

  it("lists an item by a vote in force, which gives its result", () => {
    const rows = buildGeneralRows(
      [item({ id: "1" })],
      [],
      sheet({
        itemVotes: [
          itemVote({ id: "v1", result: "rejected" }),
          itemVote({
            id: "v2",
            recordedAt: "2026-11-20T11:00:00.000Z",
            method: "assent",
            unanimous: true,
          }),
        ],
      }),
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toEqual({
      result: "approved_unanimous",
      treated: true,
      byVote: true,
    });
    expect(rows[0]!.autoTreated).toBe(true);
    expect(itemTreatedControl(rows[0]!).lock).toBe("auto");
    expect(
      rowVoteEntries(rows[0]!).map((entry) => [
        entry.id,
        entry.label,
        entry.decides,
      ]),
    ).toEqual([
      ["v1", "Ratificación", false],
      ["v2", "Ratificación", true],
    ]);
  });

  it("leaves voided votes out of the result and the cell", () => {
    const rows = buildGeneralRows(
      [item({ id: "1" })],
      [],
      sheet({
        itemVotes: [
          itemVote({ id: "v1", voidedAt: "2026-11-20T12:00:00.000Z" }),
        ],
      }),
      null,
    );
    // Voided, it no longer lists the item.
    expect(rows).toEqual([]);
    const listed = buildGeneralRows(
      [item({ id: "1", voted: true })],
      [],
      sheet({
        itemVotes: [
          itemVote({ id: "v1", voidedAt: "2026-11-20T12:00:00.000Z" }),
        ],
      }),
      null,
    );
    expect(listed[0]!.itemVotes.map((entry) => entry.id)).toEqual(["v1"]);
    expect(listed[0]!.outcome.result).toBeNull();
    expect(rowVoteEntries(listed[0]!)).toEqual([]);
  });

  it("takes no vote of its own while a document of it is voted, drafts aside", () => {
    const [row] = buildGeneralRows(
      [item({ id: "1", voted: true })],
      [document({ id: "d1", agendaItemId: "1" })],
      sheet({
        itemVotes: [itemVote({ id: "v1", result: "rejected" })],
      }),
      null,
    );
    expect(row!.votedThroughDocuments).toBe(true);
    expect(row!.takesOwnVote).toBe(false);
    // The document's final vote is still to come: its own vote counts for nothing.
    expect(row!.outcome.result).toBeNull();
    expect(rowVoteEntries(row!)).toEqual([]);

    const [withDraft] = buildGeneralRows(
      [item({ id: "1", voted: true })],
      [document({ id: "d1", agendaItemId: "1", status: "draft" })],
      sheet(),
      null,
    );
    expect(withDraft!.takesOwnVote).toBe(true);
  });

  it("offers no vote of its own on an item where members present", () => {
    const [row] = buildGeneralRows(
      [item({ id: "1", voted: true, acceptsSubmissions: true })],
      [],
      sheet(),
      null,
    );
    expect(row!.takesOwnVote).toBe(false);
    expect(row!.votedThroughDocuments).toBe(false);
  });

  it("gives each row its place, the items above and its parent", () => {
    const rows = buildGeneralRows(
      [
        item({ id: "1", order: 0, title: "Informes" }),
        item({ id: "2", order: 1, title: "Resoluciones" }),
        item({ id: "2a", parentId: "2", order: 0, title: "RES 1" }),
      ],
      [document({ id: "d1", agendaItemId: "2a" })],
      sheet(),
      null,
    );
    expect(
      rows.map((row) => [row.id, row.index, row.ancestorIds, row.parent]),
    ).toEqual([
      ["2", 1, [], null],
      ["2a", 2, ["2"], { number: "2", title: "Resoluciones" }],
    ]);
  });
});

describe("treated controls", () => {
  const itemRow = (over: Partial<ControlSheetItemRowDto>) => ({
    id: "r1",
    agendaItemId: "1",
    listed: true,
    listedUpdatedAt: "2026-11-20T10:00:00.000Z",
    manualResult: null,
    resultUpdatedAt: null,
    treated: null,
    progressUpdatedAt: null,
    observations: "",
    observationsEdited: null,
    observationsUpdatedAt: null,
    ...over,
  });

  it("locks an item its documents' votes treat", () => {
    const [, row] = buildGeneralRows(
      [item({ id: "1", order: 0 }), item({ id: "1a", parentId: "1" })],
      [document({ id: "d1", agendaItemId: "1a" })],
      sheet({
        documents: [
          { id: "d1", finalVote: vote(), amendments: 0, undecided: 0 },
        ],
      }),
      null,
    );
    expect(itemTreatedControl(row!)).toEqual({
      treated: true,
      lock: "auto",
      token: null,
    });
  });

  it("locks an item a «Decaído» by hand treats", () => {
    const [row] = buildGeneralRows(
      [item({ id: "1" })],
      [],
      sheet({ itemRows: [itemRow({ manualResult: "lapsed" })] }),
      null,
    );
    expect(itemTreatedControl(row!).lock).toBe("result");
    expect(itemTreatedControl(row!).treated).toBe(true);
  });

  it("leaves the Mesa's mark free, with its token", () => {
    const at = "2026-11-20T11:00:00.000Z";
    const [row] = buildGeneralRows(
      [item({ id: "1" })],
      [],
      sheet({
        itemRows: [
          itemRow({
            treated: { by: "Mesa", at },
            progressUpdatedAt: at,
          }),
        ],
      }),
      null,
    );
    expect(itemTreatedControl(row!)).toEqual({
      treated: true,
      lock: null,
      token: at,
    });
  });

  it("locks an amendment the Mesa settled in session", () => {
    const row = {
      treated: true,
      autoTreated: true,
      sheet: null,
    } as unknown as AmendmentSheetRow;
    expect(amendmentTreatedControl(row)).toEqual({
      treated: true,
      lock: "auto",
      token: null,
    });
    const marked = {
      treated: false,
      autoTreated: false,
      sheet: { treatedUpdatedAt: "2026-11-20T11:00:00.000Z" },
    } as unknown as AmendmentSheetRow;
    expect(amendmentTreatedControl(marked)).toEqual({
      treated: false,
      lock: null,
      token: "2026-11-20T11:00:00.000Z",
    });
  });
});

describe("staleSheetRow", () => {
  it("reads the row of a stale 409, however it is wrapped", () => {
    const row = { id: "r1" };
    expect(
      staleSheetRow({ data: { data: { reason: "control_sheet_stale", row } } }),
    ).toBe(row);
    expect(
      staleSheetRow({ data: { reason: "control_sheet_stale", row } }),
    ).toBe(row);
  });

  it("ignores any other failure", () => {
    expect(staleSheetRow({ data: { data: { reason: "other" } } })).toBeNull();
    expect(staleSheetRow(new Error("boom"))).toBeNull();
    expect(staleSheetRow(null)).toBeNull();
  });
});

const amendment = (over: Partial<AmendmentDto>): AmendmentDto =>
  ({
    id: "a",
    documentId: "d",
    number: 1,
    code: "UGR1",
    kind: "partial",
    status: "submitted",
    admission: "admitted",
    late: false,
    positionKey: 0,
    authors: [],
    mainAuthorId: null,
    approvalMethod: null,
    decidedAt: null,
    outcomeVote: null,
    position: null,
    sourceIds: [],
    transactionalIds: [],
    acceptances: [],
    ...over,
  }) as AmendmentDto;

describe("buildAmendmentRows", () => {
  const answer = (
    position: "accept" | "reject",
  ): NonNullable<AmendmentDto["position"]> => ({
    position,
    comment: null,
    recordedBy: "presenter",
    updatedAt: "2026-11-19T10:00:00.000Z",
  });

  it("shows the sheet's answer, else the amendment's", () => {
    const rows = buildAmendmentRows(
      [
        // The assembly's rule hides a1's answer from this reader.
        amendment({ id: "a1", positionKey: 0 }),
        amendment({ id: "a2", positionKey: 1, position: answer("reject") }),
        amendment({ id: "a3", positionKey: 2 }),
      ],
      null,
      null,
      [],
      [{ amendmentId: "a1", position: answer("accept") }],
    );
    expect(
      rows.map((row) => [row.amendment.id, row.position?.position ?? null]),
    ).toEqual([
      ["a1", "accept"],
      ["a2", "reject"],
      ["a3", null],
    ]);
    // The amendment itself is left as the server sent it.
    expect(rows[0]!.amendment.position).toBeNull();
  });

  it("prefers the sheet's answer when both carry one", () => {
    const [row] = buildAmendmentRows(
      [amendment({ id: "a1", position: answer("reject") })],
      null,
      null,
      [],
      [{ amendmentId: "a1", position: answer("accept") }],
    );
    expect(row!.position?.position).toBe("accept");
  });

  it("leaves out the live view's sentence for one out of time", () => {
    const [row] = buildAmendmentRows(
      [amendment({ id: "a1", late: true, admission: "pending" })],
      null,
      null,
    );
    expect(row!.state).toBe("late");
    expect(row!.note).toBeNull();
  });
});

describe("newerPosition", () => {
  const answer = (position: "accept" | "pending", updatedAt: string) =>
    ({ position, comment: null, updatedAt, recordedBy: "presenter" }) as never;
  it("shows the later answer, the sheet's on a tie", () => {
    const old = answer("pending", "2026-11-15T10:00:00.000Z");
    const fresh = answer("accept", "2026-11-15T10:05:00.000Z");
    expect(newerPosition(old, fresh)).toBe(fresh);
    expect(newerPosition(fresh, old)).toBe(fresh);
    expect(newerPosition(old, null)).toBe(old);
    expect(newerPosition(null, fresh)).toBe(fresh);
    const tie = answer("accept", "2026-11-15T10:00:00.000Z");
    expect(newerPosition(tie, old)).toBe(tie);
  });
});

describe("amendedDocuments", () => {
  it("keeps documents with amendments, in agenda order", () => {
    const items = [item({ id: "a", order: 0 }), item({ id: "b", order: 1 })];
    const list = amendedDocuments(
      [
        document({ id: "d2", agendaItemId: "b" }),
        document({ id: "d1", agendaItemId: "a" }),
        document({ id: "d3", agendaItemId: "a" }),
      ],
      sheet({
        documents: [
          { id: "d1", finalVote: null, amendments: 3, undecided: 1 },
          { id: "d2", finalVote: null, amendments: 1, undecided: 0 },
          { id: "d3", finalVote: null, amendments: 0, undecided: 0 },
        ],
      }),
      items,
    );
    expect(list.map((entry) => [entry.id, entry.undecided])).toEqual([
      ["d1", 1],
      ["d2", 0],
    ]);
  });
});

describe("live filters", () => {
  it("refetches on anything recorded but screen moves and headcounts", () => {
    expect(
      affectsControlSheet([{ type: "live_changed", entityType: "live" }]),
    ).toBe(false);
    expect(
      affectsControlSheet([
        { type: "headcount_taken", entityType: "headcount" },
      ]),
    ).toBe(false);
    expect(
      affectsControlSheet([{ type: "vote_recorded", entityType: "vote" }]),
    ).toBe(true);
    expect(
      affectsControlSheet([{ type: "poll", entityType: "assembly" }]),
    ).toBe(true);
  });

  it("follows the debate on screen moves", () => {
    expect(affectsLiveDebate([{ type: "live_changed" }])).toBe(true);
    expect(affectsLiveDebate([{ type: "vote_recorded" }])).toBe(false);
  });
});

describe("documentAgendaTrail", () => {
  const agenda = [
    item({ id: "a", slug: "informes", title: "Informes", order: 0 }),
    item({
      id: "b",
      slug: "posicionamientos",
      title: "Posicionamientos",
      order: 1,
      acceptsSubmissions: true,
    }),
    item({
      id: "b1",
      slug: "becas",
      parentId: "b",
      title: "Sistema de Becas",
      order: 0,
      generatedForDocumentId: "d1",
    }),
    item({
      id: "b2",
      slug: "movilidad",
      parentId: "b",
      title: "Movilidad",
      order: 1,
      generatedForDocumentId: "d2",
    }),
  ];

  it("names the items above the document, root first, as numbered", () => {
    expect(
      documentAgendaTrail(agenda, { id: "d2", agendaItemId: "b2" }),
    ).toEqual([
      {
        id: "b",
        slug: "posicionamientos",
        number: "2",
        title: "Posicionamientos",
        ownItem: false,
      },
      {
        id: "b2",
        slug: "movilidad",
        number: "2.2",
        title: "Movilidad",
        ownItem: true,
      },
    ]);
  });

  it("keeps an ordinary item as such, and knows no item it is not given", () => {
    expect(
      documentAgendaTrail(agenda, { id: "d9", agendaItemId: "a" }),
    ).toEqual([
      {
        id: "a",
        slug: "informes",
        number: "1",
        title: "Informes",
        ownItem: false,
      },
    ]);
    expect(
      documentAgendaTrail(agenda, { id: "d9", agendaItemId: "zz" }),
    ).toEqual([]);
  });
});

describe("amendmentSheetKind", () => {
  it("reads «De forma» only for a formal amendment", () => {
    expect(amendmentSheetKind({ kind: "formal" })).toBe("formal");
    for (const kind of ["partial", "transactional"] as const) {
      expect(amendmentSheetKind({ kind })).toBe("content");
    }
  });
});

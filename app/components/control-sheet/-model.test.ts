import { describe, expect, it } from "vitest";
import type {
  AgendaItemDto,
  AmendmentDto,
  ControlSheetDto,
  ControlSheetItemRowDto,
  DocumentSummaryDto,
  SpeakingTurnDto,
  VoteDto,
} from "~~/shared/types/api";
import {
  affectsControlSheet,
  affectsLiveDebate,
  affectsSheetAmendments,
  affectsSheetPreview,
  followWaitsForPanel,
  amendedDocuments,
  amendmentSheetKind,
  amendmentTreatedControl,
  buildAmendmentRows,
  newerPosition,
  buildGeneralRows,
  documentAgendaTrail,
  itemTreatedControl,
  previewAmendmentRows,
  rowVoteEntries,
  sheetTurnsFromNotes,
  staleSheetRow,
  type AmendmentSheetRow,
  itemVoteNeedsLabel,
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
  notCast: 0,
  present: null,
  majority: "simple",
  result: "approved",
  note: null,
  question: null,
  unanimous: false,
  options: null,
  winningOption: null,
  tieResolution: null,
  winnerOutcome: null,
  ballots: null,
  blocAmendmentIds: null,
  election: null,
  recordedAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  voidedAt: null,
  ...over,
});

const sheet = (over: Partial<ControlSheetDto> = {}): ControlSheetDto => ({
  projectedAmendmentIds: [],
  sessionStartedAt: null,
  documents: [],
  turns: [],
  itemRows: [],
  amendmentRows: [],
  positions: [],
  itemVotes: [],
  treated: { itemIds: [], amendmentIds: [] },
  // Null: the rows compute the awaiting set from the documents they get.
  awaitingItemIds: null,
  can: { internal: true, edit: true, moderate: false },
  ...over,
});

describe("buildGeneralRows", () => {
  const items = [
    item({ id: "1", order: 0, title: "Mesa" }),
    item({ id: "2", order: 1, title: "Resoluciones" }),
    item({ id: "2a", parentId: "2", order: 0, title: "RES 1" }),
    item({ id: "2b", parentId: "2", order: 1, title: "RES 2" }),
  ];

  it("numbers over the whole agenda and lists every item", () => {
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
      ["1", "item", false],
      ["2", "item", false],
      ["2.1", "item", false],
      ["2.2", "item", true],
    ]);
    expect(rows[3]!.outcome).toEqual({
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
            amendmentId: null,
            noted: false,
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
    expect(rows.map((row) => row.id)).toEqual(["1", "2", "2a", "2b"]);
    // The draft is no document of its row.
    expect(rows[0]!.documents).toEqual([]);
    expect(rows[2]!.speakers).toEqual([{ label: "CEUAM", names: ["Ana"] }]);
    expect(rows[2]!.outcome.result).toBe("not_applicable");
  });
});

describe("listed items", () => {
  it("lists items without documents, with their notes", () => {
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
      ["2", null],
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
    expect(rows.map((row) => row.id)).toEqual(["1", "2"]);
    expect(rows[0]).toMatchObject({
      voted: true,
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
    // Voided, it gives the item no result.
    expect(rows[0]!.outcome.result).toBeNull();
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
      ["1", 0, [], null],
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

  const marked = (at: string) => ({
    treated: { by: "Mesa", at },
    progressUpdatedAt: at,
  });

  it("locks an unmarked item waiting for its own vote", () => {
    const [row] = buildGeneralRows(
      [item({ id: "1", voted: true })],
      [],
      sheet({ itemRows: [itemRow({})] }),
      null,
    );
    expect(row!.awaitingVote).toBe(true);
    expect(itemTreatedControl(row!)).toEqual({
      treated: false,
      lock: "vote",
      token: null,
    });
  });

  it("ignores the mark of an item waiting for its own vote, but leaves it to undo", () => {
    const at = "2026-11-20T11:00:00.000Z";
    const [row] = buildGeneralRows(
      [item({ id: "1", voted: true })],
      [],
      sheet({ itemRows: [itemRow(marked(at))] }),
      null,
    );
    expect(row!.awaitingVote).toBe(true);
    expect(row!.outcome.treated).toBe(false);
    // Ticked and free: switching it off sends `treated: false`.
    expect(itemTreatedControl(row!)).toEqual({
      treated: true,
      lock: null,
      token: at,
    });
  });

  it("locks a voted document's item, and a listed group above it, until its final vote", () => {
    const at = "2026-11-20T11:00:00.000Z";
    const rows = buildGeneralRows(
      [
        item({ id: "1", order: 0 }),
        item({ id: "1a", parentId: "1", generatedForDocumentId: "d1" }),
      ],
      [document({ id: "d1", agendaItemId: "1a" })],
      sheet({
        documents: [{ id: "d1", finalVote: null, amendments: 0, undecided: 0 }],
        itemRows: [
          itemRow({ manualResult: "lapsed" }),
          itemRow({ id: "r2", agendaItemId: "1a" }),
        ],
      }),
      null,
    );
    expect(
      rows.map((row) => [row.id, itemTreatedControl(row).lock, row.outcome]),
    ).toEqual([
      ["1", "vote", { result: "lapsed", treated: false, byVote: false }],
      ["1a", "vote", { result: null, treated: false, byVote: false }],
    ]);
    // Marked before: both free to undo, the result by hand locking nothing
    // while it counts for nothing.
    const marks = buildGeneralRows(
      [
        item({ id: "1", order: 0 }),
        item({ id: "1a", parentId: "1", generatedForDocumentId: "d1" }),
      ],
      [document({ id: "d1", agendaItemId: "1a" })],
      sheet({
        documents: [{ id: "d1", finalVote: null, amendments: 0, undecided: 0 }],
        itemRows: [
          itemRow({ ...marked(at), manualResult: "lapsed" }),
          itemRow({ id: "r2", agendaItemId: "1a", ...marked(at) }),
        ],
      }),
      null,
    );
    expect(
      marks.map((row) => [
        row.id,
        itemTreatedControl(row),
        row.outcome.treated,
      ]),
    ).toEqual([
      ["1", { treated: true, lock: null, token: at }, false],
      ["1a", { treated: true, lock: null, token: at }, false],
    ]);
  });

  it("reads the server's awaiting set with a sheet key, over documents it cannot see", () => {
    const at = "2026-11-20T11:00:00.000Z";
    // The voted document under «1» is not public: this reader does not get
    // it, but the server counts it.
    const [row] = buildGeneralRows(
      [item({ id: "1" })],
      [],
      sheet({
        itemRows: [itemRow(marked(at))],
        awaitingItemIds: ["1"],
      }),
      null,
    );
    expect(row!.awaitingVote).toBe(true);
    expect(row!.outcome.treated).toBe(false);
    const [local] = buildGeneralRows(
      [item({ id: "1" })],
      [],
      sheet({ itemRows: [itemRow(marked(at))] }),
      null,
    );
    expect(local!.awaitingVote).toBe(false);
    expect(local!.outcome.treated).toBe(true);
    // An empty set from the server is the server's: nothing waits.
    const [none] = buildGeneralRows(
      [item({ id: "1", voted: true })],
      [],
      sheet({ awaitingItemIds: [] }),
      null,
    );
    expect(none!.awaitingVote).toBe(false);
  });

  it("reads a public sheet's treated ids, never while awaiting a vote", () => {
    const rows = buildGeneralRows(
      [item({ id: "1" }), item({ id: "2", voted: true, order: 1 })],
      [],
      sheet({
        can: { internal: false, edit: false, moderate: false },
        treated: { itemIds: ["1", "2"], amendmentIds: [] },
      }),
      null,
    );
    // «2» waits for its vote («Se vota el punto»); «1» was marked.
    expect(rows.map((row) => [row.id, row.outcome.treated])).toEqual([
      ["1", true],
      ["2", false],
    ]);
    const voted = buildGeneralRows(
      [item({ id: "1" })],
      [],
      sheet({
        can: { internal: false, edit: false, moderate: false },
        itemVotes: [
          vote({ id: "v1", subjectType: "agenda_item", subjectId: "1" }),
        ],
        treated: { itemIds: ["1"], amendmentIds: [] },
      }),
      null,
    );
    expect(voted[0]!.outcome.treated).toBe(true);
    const report = buildGeneralRows(
      [item({ id: "1" })],
      [document({ id: "d1", agendaItemId: "1", voted: false })],
      sheet({
        can: { internal: false, edit: false, moderate: false },
        treated: { itemIds: ["1"], amendmentIds: [] },
      }),
      null,
    );
    expect(report[0]!.outcome).toEqual({
      result: "not_applicable",
      treated: true,
      byVote: false,
    });
  });

  it("locks an undecided amendment unless a mark is there to undo", () => {
    const undecided = {
      amendment: { status: "submitted" },
      treated: false,
      autoTreated: false,
      sheet: null,
    } as unknown as AmendmentSheetRow;
    expect(amendmentTreatedControl(undecided).lock).toBe("vote");
    expect(
      amendmentTreatedControl({ ...undecided, treated: true }).lock,
    ).toBeNull();
  });

  it("locks an amendment the Mesa settled in session", () => {
    const row = {
      amendment: { status: "rejected" },
      treated: true,
      autoTreated: true,
      sheet: null,
    } as unknown as AmendmentSheetRow;
    expect(amendmentTreatedControl(row)).toEqual({
      treated: true,
      lock: "auto",
      token: null,
    });
    const unmarked = {
      amendment: { status: "approved" },
      treated: false,
      autoTreated: false,
      sheet: { treatedUpdatedAt: "2026-11-20T11:00:00.000Z" },
    } as unknown as AmendmentSheetRow;
    expect(amendmentTreatedControl(unmarked)).toEqual({
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
      new Set<string>(),
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
      new Set<string>(),
      null,
      [],
      [{ amendmentId: "a1", position: answer("accept") }],
    );
    expect(row!.position?.position).toBe("accept");
  });

  it("names who spoke on each amendment once, noted or given the floor", () => {
    const spoke = (
      id: string,
      amendmentId: string,
      memberId: string,
      noted: boolean,
    ) => ({
      id,
      member: {
        id: memberId,
        acronym: memberId.toUpperCase(),
        name: memberId,
        kind: "asociado" as const,
      },
      speaker: null,
      agendaItemId: "i1",
      amendmentId,
      noted,
      status: "done" as const,
      position: 0,
      startedAt: null,
      endedAt: null,
      limitSeconds: null,
      priority: false,
      createdAt: "2026-11-19T10:00:00.000Z",
      updatedAt: "2026-11-19T10:00:00.000Z",
    });
    const rows = buildAmendmentRows(
      [
        amendment({ id: "a1", positionKey: 0 }),
        amendment({ id: "a2", positionKey: 1 }),
      ],
      new Set<string>(),
      null,
      [],
      [],
      [
        spoke("t1", "a1", "ugr", false),
        spoke("t2", "a1", "ugr", true),
        spoke("t3", "a1", "anem", true),
        spoke("t4", "a2", "cas", false),
      ],
    );
    expect(rows.map((row) => row.speakers.map((entry) => entry.label))).toEqual(
      [["UGR", "ANEM"], ["CAS"]],
    );
  });

  it("leaves out the live view's sentence for one out of time", () => {
    const [row] = buildAmendmentRows(
      [amendment({ id: "a1", late: true, admission: "pending" })],
      new Set<string>(),
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

  it("fetches an open preview again only for what may change its document", () => {
    expect(
      affectsSheetPreview([
        { type: "speaker_added", entityType: "speakers" },
        { type: "control_sheet_treated_changed", entityType: "control_sheet" },
        { type: "seating_changed", entityType: "seating" },
        { type: "headcount_taken", entityType: "headcount" },
        { type: "live_changed", entityType: "live" },
      ]),
    ).toBe(false);
    expect(
      affectsSheetPreview([
        { type: "amendment_updated", entityType: "amendment" },
      ]),
    ).toBe(true);
    expect(
      affectsSheetPreview([{ type: "vote_recorded", entityType: "vote" }]),
    ).toBe(true);
    expect(affectsSheetPreview([{ type: "poll", entityType: "live" }])).toBe(
      true,
    );
  });

  it("follows the debate on screen moves", () => {
    expect(affectsLiveDebate([{ type: "live_changed" }])).toBe(true);
    expect(affectsLiveDebate([{ type: "vote_recorded" }])).toBe(false);
  });

  describe("the chosen document's amendments", () => {
    const doc = "doc-1";
    const event = (
      type: string,
      entityType: string,
      extra: { entityId?: string; documentId?: string } = {},
    ) => ({ type, entityType, entityId: extra.entityId ?? "x", ...extra });

    it("are not fetched again for what cannot change them", () => {
      for (const batch of [
        [event("speaking_turn_added", "speakers")],
        [event("speaking_turn_started", "speakers")],
        [event("speaking_turn_finished", "speakers")],
        [event("speaking_turn_noted", "speakers")],
        [event("speakers_visibility_changed", "speakers")],
        [event("seating_assignments_changed", "seating")],
        [event("seating_person_updated", "seating")],
        [event("control_sheet_observations_updated", "control_sheet")],
        [event("control_sheet_treated_changed", "control_sheet")],
        [event("projection_control_changed", "projection")],
        [event("headcount_recorded", "headcount")],
        // A vote on an item carries no document.
        [event("vote_recorded", "vote")],
        [event("vote_voided", "vote")],
        // What the Mesa has on screen, even on this document.
        [event("live_changed", "live", { documentId: doc })],
        // Another document's amendment, vote or the document itself.
        [event("amendment_approved", "amendment", { documentId: "doc-2" })],
        [event("vote_recorded", "vote", { documentId: "doc-2" })],
        [
          event("document_voted", "document", {
            entityId: "doc-2",
            documentId: "doc-2",
          }),
        ],
      ]) {
        expect(affectsSheetAmendments(batch, doc)).toBe(false);
      }
    });

    it("are fetched again for what may change them", () => {
      for (const batch of [
        [event("poll", "assembly")],
        [event("assembly_status_changed", "assembly")],
        [event("calendar_updated", "assembly")],
        [event("agenda_item_updated", "agenda_item")],
        [event("amendment_approved", "amendment", { documentId: doc })],
        [event("amendment_reopened", "amendment", { documentId: doc })],
        [event("position_changed", "amendment", { documentId: doc })],
        [event("vote_recorded", "vote", { documentId: doc })],
        [event("decision_recorded", "decision", { documentId: doc })],
        [
          event("document_voted", "document", {
            entityId: doc,
            documentId: doc,
          }),
        ],
        [event("document_status_changed", "document", { entityId: doc })],
        // One that matters among others that do not.
        [
          event("speaking_turn_added", "speakers"),
          event("amendment_updated", "amendment", { documentId: doc }),
        ],
      ]) {
        expect(affectsSheetAmendments(batch, doc)).toBe(true);
      }
    });

    it("are fetched again on a poll even without a document", () => {
      expect(affectsSheetAmendments([event("poll", "live")], null)).toBe(true);
      expect(
        affectsSheetAmendments(
          [event("amendment_updated", "amendment", { documentId: doc })],
          null,
        ),
      ).toBe(false);
    });
  });
});

describe("followWaitsForPanel", () => {
  it("waits while an amendment's panel is open and the debate moves to another document", () => {
    expect(
      followWaitsForPanel({ open: true, kind: "amendment" }, "doc-1", "doc-2"),
    ).toBe(true);
  });

  it("follows at once otherwise", () => {
    // The same document: the panel's row stays in the list.
    expect(
      followWaitsForPanel({ open: true, kind: "amendment" }, "doc-1", "doc-1"),
    ).toBe(false);
    // An item's panel: its row does not depend on the document shown.
    expect(
      followWaitsForPanel({ open: true, kind: "item" }, "doc-1", "doc-2"),
    ).toBe(false);
    // The panel closed.
    expect(
      followWaitsForPanel({ open: false, kind: "amendment" }, "doc-1", "doc-2"),
    ).toBe(false);
    // Nowhere to go.
    expect(
      followWaitsForPanel({ open: true, kind: "amendment" }, "doc-1", null),
    ).toBe(false);
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

describe("itemVoteNeedsLabel", () => {
  const title = "Ratificación de la Mesa de Moderación";

  it("leaves out a single vote that only repeats the item", () => {
    expect(itemVoteNeedsLabel(`1. ${title}`, title, 1)).toBe(false);
    expect(itemVoteNeedsLabel(`  ${title.toUpperCase()} `, title, 1)).toBe(
      false,
    );
    expect(itemVoteNeedsLabel(null, title, 1)).toBe(false);
  });

  it("keeps a question that says more, or one of several votes", () => {
    expect(itemVoteNeedsLabel("Ratificación de la Vocalía", title, 1)).toBe(
      true,
    );
    expect(itemVoteNeedsLabel(`1. ${title}`, title, 2)).toBe(true);
  });
});

describe("buildAmendmentRows treated", () => {
  it("takes the public ids where the sheet has no row of its own", () => {
    const rows = buildAmendmentRows(
      [
        amendment({ id: "a1", status: "approved" }),
        amendment({ id: "a2", status: "approved", positionKey: 1 }),
      ],
      new Set<string>(),
      null,
      [
        {
          id: "r2",
          amendmentId: "a2",
          documentId: "d",
          treated: null,
          treatedUpdatedAt: "2026-11-20T11:00:00.000Z",
          observations: "",
          observationsEdited: null,
          observationsUpdatedAt: null,
        },
      ],
      [],
      [],
      {},
      new Set(["a1", "a2"]),
    );
    // Settled, both count by themselves (user's decision of 2026-11-21).
    expect(rows.map((row) => [row.amendment.id, row.treated])).toEqual([
      ["a1", true],
      ["a2", true],
    ]);
  });

  it("counts a pending amendment only once projected", () => {
    const rows = buildAmendmentRows(
      [
        amendment({ id: "a1", status: "submitted" }),
        amendment({ id: "a2", status: "submitted", positionKey: 1 }),
        amendment({ id: "a3", status: "submitted", positionKey: 2 }),
      ],
      new Set(["a2"]),
      null,
      [],
      [],
      [],
      {},
      // A mark from before the rule still reads.
      new Set(["a3"]),
    );
    expect(
      rows.map((row) => [row.amendment.id, row.treated, row.autoTreated]),
    ).toEqual([
      ["a1", false, false],
      ["a2", true, true],
      ["a3", true, false],
    ]);
  });

  it("leaves out the note under «Incorporada»", () => {
    const [row] = buildAmendmentRows(
      [
        amendment({
          id: "a1",
          status: "approved",
          approvalMethod: "proponent",
        }),
      ],
      new Set<string>(),
      null,
    );
    expect(row!.state).toBe("incorporated");
    expect(row!.note).toBeNull();
  });
});

describe("sheetTurnsFromNotes", () => {
  const turn = (id: string, agendaItemId: string | null) =>
    ({ id, agendaItemId, amendmentId: null }) as SpeakingTurnDto;

  it("keeps the turns of items the reader gets, and those of no item", () => {
    expect(
      sheetTurnsFromNotes(
        [turn("t1", "1"), turn("t2", "hidden"), turn("t3", null)],
        new Set(["1"]),
      ).map((entry) => entry.id),
    ).toEqual(["t1", "t3"]);
  });
});

describe("previewAmendmentRows", () => {
  it("gives each amendment the answer its row shows, its state and whether it is on screen", () => {
    const answer = {
      position: "accept" as const,
      comment: null,
      recordedBy: "presenter" as const,
      updatedAt: "2026-11-19T10:00:00.000Z",
    };
    const rows = [
      {
        amendment: amendment({ id: "a1" }),
        state: "pending",
        position: answer,
        live: true,
      },
      {
        amendment: amendment({ id: "a2" }),
        state: "approved",
        position: null,
        live: false,
      },
    ] as unknown as AmendmentSheetRow[];
    const preview = previewAmendmentRows(rows);
    expect(
      preview.map((row) => [
        row.amendment.id,
        row.amendment.position?.position ?? null,
        row.state,
        row.current,
      ]),
    ).toEqual([
      ["a1", "accept", "pending", true],
      ["a2", null, "approved", false],
    ]);
    // The row's own amendment is left untouched.
    expect(rows[0]!.amendment.position).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type {
  AgendaItemDto,
  ControlSheetDto,
  DocumentSummaryDto,
  VoteDto,
} from "~~/shared/types/api";
import {
  affectsControlSheet,
  affectsLiveDebate,
  amendedDocuments,
  buildGeneralRows,
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
  recordedAt: "2026-11-20T10:00:00.000Z",
  ...over,
});

const sheet = (over: Partial<ControlSheetDto> = {}): ControlSheetDto => ({
  sessionStartedAt: null,
  documents: [],
  turns: [],
  itemRows: [],
  amendmentRows: [],
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

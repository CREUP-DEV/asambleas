import { describe, expect, it } from "vitest";
import {
  itemsAwaitingVote,
  itemsPresentedTreated,
  sessionMarkAction,
  sessionTreatedItems,
  type ProgressDocument,
  type ProgressItem,
} from "./sessionProgress";
import type { SheetVote } from "./controlSheet";

const item = (
  id: string,
  parentId: string | null = null,
  generatedForDocumentId: string | null = null,
): ProgressItem => ({ id, parentId, generatedForDocumentId });

// 1 (two documents, each with its automatic sub-item), 2, 3 > 3.1, 3.2.
const AGENDA = [
  item("1"),
  item("1a", "1", "d1"),
  item("1b", "1", "d2"),
  item("2"),
  item("3"),
  item("31", "3"),
  item("32", "3"),
  item("32a", "32", "d3"),
  item("4"),
];

describe("itemsPresentedTreated", () => {
  it("marks the item presented and nothing above it", () => {
    expect(
      itemsPresentedTreated(AGENDA, {
        agendaItemId: "31",
        documentItemId: null,
      }),
    ).toEqual(["31"]);
    expect(
      itemsPresentedTreated(AGENDA, {
        agendaItemId: "3",
        documentItemId: null,
      }),
    ).toEqual(["3"]);
  });

  it("marks a document's own item, once", () => {
    expect(
      itemsPresentedTreated(AGENDA, {
        agendaItemId: "1a",
        documentItemId: "1a",
      }),
    ).toEqual(["1a"]);
    expect(
      itemsPresentedTreated(AGENDA, {
        agendaItemId: "1",
        documentItemId: "1b",
      }),
    ).toEqual(["1", "1b"]);
  });

  it("marks nothing when nothing is presented, or the agenda lacks it", () => {
    expect(
      itemsPresentedTreated(AGENDA, {
        agendaItemId: null,
        documentItemId: null,
      }),
    ).toEqual([]);
    expect(
      itemsPresentedTreated(AGENDA, {
        agendaItemId: "gone",
        documentItemId: null,
      }),
    ).toEqual([]);
  });

  it("leaves out what still waits for a vote", () => {
    expect(
      itemsPresentedTreated(
        AGENDA,
        { agendaItemId: "1", documentItemId: "1b" },
        new Set(["1", "1b"]),
      ),
    ).toEqual([]);
  });
});

describe("itemsAwaitingVote", () => {
  const document = (
    id: string,
    agendaItemId: string,
    over: Partial<ProgressDocument> = {},
  ): ProgressDocument => ({
    id,
    agendaItemId,
    voted: true,
    status: "published",
    finalVoteId: null,
    ...over,
  });

  it("waits for each voted document's final vote, and the items above it", () => {
    const waiting = itemsAwaitingVote(
      AGENDA,
      [
        document("d1", "1", { finalVoteId: "v1" }),
        document("d2", "1"),
        document("d3", "32"),
      ],
      new Set(),
    );
    expect([...waiting].sort()).toEqual(["1", "1b", "3", "32", "32a"]);
  });

  it("never waits for a document not voted, withdrawn or still a draft", () => {
    const waiting = itemsAwaitingVote(
      AGENDA,
      [
        document("d1", "1", { voted: false }),
        document("d2", "1", { status: "withdrawn" }),
        document("d3", "32", { status: "draft" }),
      ],
      new Set(),
    );
    expect(waiting.size).toBe(0);
  });

  it("waits for the vote of an item marked «Se vota el punto»", () => {
    const agenda = [...AGENDA, { ...item("5"), voted: true }];
    expect([...itemsAwaitingVote(agenda, [], new Set())]).toEqual(["5"]);
    expect(itemsAwaitingVote(agenda, [], new Set(["5"])).size).toBe(0);
  });
});

describe("sessionTreatedItems", () => {
  const finalVote: SheetVote = {
    method: "show_of_hands",
    result: "approved",
    inFavor: 10,
    against: 1,
    abstentions: 0,
    blank: 0,
    invalid: 0,
  };
  const items = AGENDA.map((entry) => ({ ...entry, voted: false }));
  const document = (
    id: string,
    agendaItemId: string,
    over: Partial<ProgressDocument & { finalVote: SheetVote | null }> = {},
  ) => ({
    id,
    agendaItemId,
    voted: true,
    status: "published" as const,
    finalVoteId: null,
    finalVote: null,
    ...over,
  });
  const byId = (list: ReturnType<typeof sessionTreatedItems>) =>
    new Map(list.map((entry) => [entry.id, entry]));

  it("reads an item voted, marked or settled by hand, and why", () => {
    const result = byId(
      sessionTreatedItems(
        items,
        [
          document("d1", "1a", { finalVoteId: "v1", finalVote }),
          document("d2", "1b", { voted: false }),
        ],
        [],
        [
          {
            agendaItemId: "1b",
            treated: true,
            manualResult: null,
            token: "t1",
          },
          {
            agendaItemId: "2",
            treated: false,
            manualResult: "lapsed",
            token: "t2",
          },
        ],
      ),
    );
    expect(result.get("1a")).toMatchObject({ treated: true, by: "auto" });
    expect(result.get("1b")).toMatchObject({
      treated: true,
      by: "mark",
      token: "t1",
    });
    expect(result.get("2")).toMatchObject({ treated: true, by: "result" });
    expect(result.get("4")).toMatchObject({
      treated: false,
      by: null,
      token: null,
    });
  });

  it("never treats by a mark what waits for a vote", () => {
    const result = byId(
      sessionTreatedItems(
        items,
        [document("d1", "1a")],
        [],
        [
          {
            agendaItemId: "1a",
            treated: true,
            manualResult: null,
            token: "t",
          },
        ],
      ),
    );
    expect(result.get("1a")).toMatchObject({
      treated: false,
      by: null,
      awaitingVote: true,
      // Still there, for the Mesa to take away.
      marked: true,
      token: "t",
    });
    expect(sessionMarkAction(result.get("1a")!)).toBe("unmark");
    expect(result.get("1")).toMatchObject({ awaitingVote: true });
  });

  it("treats an item by its own vote in force, not a voided one", () => {
    const voted = items.map((entry) =>
      entry.id === "4" ? { ...entry, voted: true } : entry,
    );
    const vote = {
      ...finalVote,
      id: "v",
      subjectId: "4",
      recordedAt: "2026-01-01T10:00:00.000Z",
      voidedAt: null as string | null,
    };
    expect(byId(sessionTreatedItems(voted, [], [vote], [])).get("4")).toEqual({
      id: "4",
      treated: true,
      by: "auto",
      awaitingVote: false,
      marked: false,
      token: null,
    });
    expect(
      byId(
        sessionTreatedItems(
          voted,
          [],
          [{ ...vote, voidedAt: "2026-01-01T11:00:00.000Z" }],
          [],
        ),
      ).get("4"),
    ).toMatchObject({ treated: false, awaitingVote: true });
  });

  it("leaves drafts out, as the sheet does", () => {
    const result = byId(
      sessionTreatedItems(
        items,
        [
          document("d1", "1a", { status: "withdrawn" }),
          document("d2", "1a", { status: "draft", voted: false }),
        ],
        [],
        [],
      ),
    );
    expect(result.get("1a")).toMatchObject({ treated: true, by: "auto" });
  });

  it("reads a group treated once all under it are", () => {
    const marks = ["31", "32", "32a"].map((agendaItemId) => ({
      agendaItemId,
      treated: true,
      manualResult: null,
      token: "t",
    }));
    const all = byId(sessionTreatedItems(items, [], [], marks));
    expect(all.get("32")).toMatchObject({ treated: true, by: "mark" });
    expect(all.get("3")).toMatchObject({ treated: true, by: "children" });
    const some = byId(sessionTreatedItems(items, [], [], marks.slice(1)));
    expect(some.get("3")).toMatchObject({ treated: false, by: null });
    // An item with nothing under it never reads treated by its children.
    expect(some.get("2")).toMatchObject({ treated: false });
  });
});

describe("sessionMarkAction", () => {
  const entry = (
    over: Partial<Parameters<typeof sessionMarkAction>[0]> = {},
  ) => ({
    treated: false,
    by: null,
    awaitingVote: false,
    marked: false,
    ...over,
  });

  it("undoes a mark, one left on an item now waiting for a vote included", () => {
    expect(
      sessionMarkAction(entry({ treated: true, by: "mark", marked: true })),
    ).toBe("unmark");
    expect(sessionMarkAction(entry({ awaitingVote: true, marked: true }))).toBe(
      "unmark",
    );
  });

  it("sets one only on an item neither treated nor waiting for a vote", () => {
    expect(sessionMarkAction(entry())).toBe("mark");
    expect(sessionMarkAction(entry({ awaitingVote: true }))).toBeNull();
  });

  it("never undoes what votes, a result by hand or its items treat", () => {
    for (const by of ["auto", "result", "children"] as const) {
      expect(
        sessionMarkAction(
          entry({ treated: true, by, marked: by === "result" }),
        ),
      ).toBeNull();
    }
  });
});

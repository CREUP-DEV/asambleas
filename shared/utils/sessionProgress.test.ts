import { describe, expect, it } from "vitest";
import {
  itemsAwaitingVote,
  itemsLeftTreated,
  type ProgressDocument,
  type ProgressItem,
} from "./sessionProgress";

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

describe("itemsLeftTreated", () => {
  it("marks the item left and its documents' sub-items", () => {
    expect(itemsLeftTreated(AGENDA, "1", "2")).toEqual(["1", "1a", "1b"]);
  });

  it("marks nothing going down into the item or staying on it", () => {
    expect(itemsLeftTreated(AGENDA, "3", "31")).toEqual([]);
    expect(itemsLeftTreated(AGENDA, "1", "1a")).toEqual([]);
    expect(itemsLeftTreated(AGENDA, "2", "2")).toEqual([]);
    expect(itemsLeftTreated(AGENDA, null, "2")).toEqual([]);
    expect(itemsLeftTreated(AGENDA, "2", null)).toEqual([]);
  });

  it("leaves the parent open between its sub-items", () => {
    expect(itemsLeftTreated(AGENDA, "31", "32")).toEqual(["31"]);
  });

  it("marks the parent too once the debate leaves it", () => {
    expect(itemsLeftTreated(AGENDA, "32", "4")).toEqual(["32", "3", "32a"]);
  });

  it("marks an item left for one before it", () => {
    expect(itemsLeftTreated(AGENDA, "2", "1")).toEqual(["2"]);
  });

  it("ignores an item the agenda no longer has", () => {
    expect(itemsLeftTreated(AGENDA, "gone", "2")).toEqual([]);
  });

  it("leaves out what still waits for a vote", () => {
    expect(itemsLeftTreated(AGENDA, "1", "2", new Set(["1", "1b"]))).toEqual([
      "1a",
    ]);
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

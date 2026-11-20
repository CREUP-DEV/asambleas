import { describe, expect, it } from "vitest";
import { sessionLeavesPendingVote } from "./sessionModel";

describe("sessionLeavesPendingVote", () => {
  // 1, 2 (with 2.1 and 2.2), 3.
  const items = [
    { id: "i1", parentId: null },
    { id: "i2", parentId: null },
    { id: "i21", parentId: "i2" },
    { id: "i22", parentId: "i2" },
    { id: "i3", parentId: null },
  ];
  const awaitingOf =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id);

  it("asks when the item left waits for a vote and the next is another", () => {
    expect(sessionLeavesPendingVote(items, awaitingOf("i1"), "i1", "i2")).toBe(
      true,
    );
    expect(sessionLeavesPendingVote(items, awaitingOf("i1"), "i1", null)).toBe(
      true,
    );
  });

  it("never asks for an item without a pending vote, or staying on it", () => {
    expect(sessionLeavesPendingVote(items, awaitingOf(), "i1", "i2")).toBe(
      false,
    );
    expect(sessionLeavesPendingVote(items, awaitingOf("i1"), "i1", "i1")).toBe(
      false,
    );
    expect(sessionLeavesPendingVote(items, awaitingOf("i1"), null, "i2")).toBe(
      false,
    );
  });

  it("keeps the vote at hand inside the item, down or back up", () => {
    const awaiting = awaitingOf("i2", "i21");
    expect(sessionLeavesPendingVote(items, awaiting, "i2", "i21")).toBe(false);
    expect(sessionLeavesPendingVote(items, awaiting, "i21", "i2")).toBe(false);
  });

  it("asks when moving to a sibling or out of the group", () => {
    const awaiting = awaitingOf("i2", "i21");
    expect(sessionLeavesPendingVote(items, awaiting, "i21", "i22")).toBe(true);
    expect(sessionLeavesPendingVote(items, awaiting, "i2", "i3")).toBe(true);
  });
});

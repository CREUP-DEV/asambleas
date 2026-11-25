import { describe, expect, it } from "vitest";
import type { SpeakingTurnDto } from "~~/shared/types/api";
import { sessionRemovedTurns, sessionRestorePlace } from "./removedTurns";

function turn(
  id: string,
  status: SpeakingTurnDto["status"],
  extra: Partial<SpeakingTurnDto> = {},
): SpeakingTurnDto {
  return {
    id,
    member: null,
    speaker: id,
    agendaItemId: "item",
    amendmentId: null,
    noted: false,
    status,
    position: 0,
    startedAt: null,
    endedAt: null,
    limitSeconds: null,
    priority: false,
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:00:00.000Z",
    ...extra,
  };
}

describe("sessionRemovedTurns", () => {
  it("lists the cancelled turns of the item in debate, the last taken off first", () => {
    const turns = [
      turn("w", "waiting"),
      turn("s", "speaking"),
      turn("d", "done"),
      turn("a", "cancelled", { endedAt: "2026-11-25T10:01:00.000Z" }),
      turn("b", "cancelled", { endedAt: "2026-11-25T10:05:00.000Z" }),
    ];
    expect(sessionRemovedTurns(turns, "item").map((t) => t.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("leaves out a turn carried over from another item and noted turns", () => {
    const turns = [
      turn("other", "cancelled", { agendaItemId: "earlier" }),
      turn("noted", "cancelled", { noted: true }),
      turn("here", "cancelled"),
    ];
    expect(sessionRemovedTurns(turns, "item").map((t) => t.id)).toEqual([
      "here",
    ]);
  });

  it("matches turns without an item when nothing is in debate", () => {
    const turns = [
      turn("none", "cancelled", { agendaItemId: null }),
      turn("item", "cancelled"),
    ];
    expect(sessionRemovedTurns(turns, null).map((t) => t.id)).toEqual(["none"]);
  });
});

describe("sessionRestorePlace", () => {
  it("puts the turn back at the place it had", () => {
    expect(sessionRestorePlace({ position: 2 }, 5)).toBe(2);
    expect(sessionRestorePlace({ position: 0 }, 5)).toBe(0);
  });

  it("puts it at the end when the queue is shorter now", () => {
    expect(sessionRestorePlace({ position: 6 }, 3)).toBe(3);
    expect(sessionRestorePlace({ position: 4 }, 0)).toBe(0);
  });

  it("never sends a negative place", () => {
    expect(sessionRestorePlace({ position: -1 }, 3)).toBe(0);
  });
});

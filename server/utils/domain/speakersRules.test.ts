import { describe, expect, it } from "vitest";
import type { SpeakingTurnStatus } from "~~/shared/constants/domain";
import {
  canChangeTurnStatus,
  moveInQueue,
  planTurnUpdate,
  sortTurns,
  turnEventType,
  turnsForActor,
  waitingQueue,
  type ListedTurn,
} from "./speakersRules";

const minute = (n: number) => new Date(Date.UTC(2026, 10, 5, 10, n));

function turn(
  id: string,
  status: SpeakingTurnStatus,
  overrides: Partial<ListedTurn> = {},
): ListedTurn {
  return {
    id,
    status,
    position: 0,
    createdAt: minute(0),
    agendaItemId: "item1",
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe("canChangeTurnStatus", () => {
  it("gives and ends the floor, and cancels", () => {
    expect(canChangeTurnStatus("waiting", "speaking")).toBe(true);
    expect(canChangeTurnStatus("waiting", "cancelled")).toBe(true);
    expect(canChangeTurnStatus("speaking", "done")).toBe(true);
    expect(canChangeTurnStatus("speaking", "cancelled")).toBe(true);
  });

  it("lets a cancelled turn go back to the queue", () => {
    expect(canChangeTurnStatus("cancelled", "waiting")).toBe(true);
  });

  it("keeps a finished turn finished", () => {
    for (const to of ["waiting", "speaking", "cancelled"] as const) {
      expect(canChangeTurnStatus("done", to)).toBe(false);
    }
    expect(canChangeTurnStatus("waiting", "done")).toBe(false);
    expect(canChangeTurnStatus("done", "done")).toBe(true);
  });
});

describe("waitingQueue and moveInQueue", () => {
  it("orders by position, then arrival", () => {
    const queue = waitingQueue([
      turn("c", "waiting", { position: 1, createdAt: minute(3) }),
      turn("a", "waiting", { position: 0 }),
      turn("s", "speaking"),
      turn("b", "waiting", { position: 1, createdAt: minute(2) }),
    ]);
    expect(queue.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("moves a turn and clamps the place to the queue", () => {
    expect(moveInQueue(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveInQueue(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveInQueue(["a", "b"], "x", -3)).toEqual(["x", "a", "b"]);
  });
});

describe("planTurnUpdate", () => {
  const queue = ["a", "b", "c"];

  it("gives the floor and ends the turn that was speaking", () => {
    const plan = planTurnUpdate({
      turn: { id: "b", status: "waiting" },
      queue,
      speakingIds: ["s"],
      status: "speaking",
    });
    expect(plan).toEqual({
      status: "speaking",
      start: true,
      end: false,
      reset: false,
      finishIds: ["s"],
      queue: ["a", "c"],
    });
  });

  it("reorders a waiting turn", () => {
    const plan = planTurnUpdate({
      turn: { id: "c", status: "waiting" },
      queue,
      speakingIds: [],
      position: 0,
    });
    expect(plan).toMatchObject({ status: "waiting", queue: ["c", "a", "b"] });
  });

  it("keeps the place of a waiting turn when only its name changes", () => {
    const plan = planTurnUpdate({
      turn: { id: "b", status: "waiting" },
      queue,
      speakingIds: [],
    });
    expect(plan).toMatchObject({ queue, start: false, end: false });
  });

  it("puts a restored turn at the end of the queue", () => {
    const plan = planTurnUpdate({
      turn: { id: "x", status: "cancelled" },
      queue,
      speakingIds: [],
      status: "waiting",
    });
    expect(plan).toMatchObject({ reset: true, queue: ["a", "b", "c", "x"] });
  });

  it("ends the floor and takes a cancelled turn out of the queue", () => {
    expect(
      planTurnUpdate({
        turn: { id: "s", status: "speaking" },
        queue,
        speakingIds: ["s"],
        status: "done",
      }),
    ).toMatchObject({ end: true, finishIds: [], queue });
    expect(
      planTurnUpdate({
        turn: { id: "a", status: "waiting" },
        queue,
        speakingIds: [],
        status: "cancelled",
      }),
    ).toMatchObject({ end: true, queue: ["b", "c"] });
  });

  it("refuses impossible changes and moving a turn that is not waiting", () => {
    expect(
      planTurnUpdate({
        turn: { id: "d", status: "done" },
        queue,
        speakingIds: [],
        status: "speaking",
      }),
    ).toBe("transition");
    expect(
      planTurnUpdate({
        turn: { id: "s", status: "speaking" },
        queue,
        speakingIds: ["s"],
        position: 0,
      }),
    ).toBe("not_waiting");
  });
});

describe("turnsForActor", () => {
  const turns = [
    turn("s", "speaking"),
    turn("w", "waiting", { agendaItemId: "item2" }),
    turn("d1", "done"),
    turn("d2", "done", { agendaItemId: "item2" }),
    turn("c", "cancelled", { agendaItemId: null }),
  ];

  it("gives the Mesa the open turns and every turn of the item in debate", () => {
    const ids = (agendaItemId: string | null) =>
      turnsForActor(turns, {
        moderate: true,
        visible: false,
        agendaItemId,
      }).map((item) => item.id);
    expect(ids("item1")).toEqual(["s", "w", "d1"]);
    expect(ids(null)).toEqual(["s", "w", "c"]);
  });

  it("shows attendees the floor and the queue only while visible", () => {
    expect(
      turnsForActor(turns, {
        moderate: false,
        visible: true,
        agendaItemId: "item1",
      }).map((item) => item.id),
    ).toEqual(["s", "w"]);
    expect(
      turnsForActor(turns, {
        moderate: false,
        visible: false,
        agendaItemId: "item1",
      }),
    ).toEqual([]);
  });
});

describe("sortTurns", () => {
  it("lists who speaks, the queue, then what already happened", () => {
    const sorted = sortTurns([
      turn("d2", "done", { startedAt: minute(5) }),
      turn("w2", "waiting", { position: 1 }),
      turn("c", "cancelled", { endedAt: minute(2) }),
      turn("s", "speaking", { startedAt: minute(9) }),
      turn("w1", "waiting", { position: 0 }),
      turn("d1", "done", { startedAt: minute(1) }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual([
      "s",
      "w1",
      "w2",
      "d1",
      "c",
      "d2",
    ]);
  });
});

describe("turnEventType", () => {
  it("names the change", () => {
    expect(
      turnEventType({ from: "waiting", to: "speaking", moved: true }),
    ).toBe("speaking_turn_started");
    expect(turnEventType({ from: "speaking", to: "done", moved: false })).toBe(
      "speaking_turn_finished",
    );
    expect(
      turnEventType({ from: "cancelled", to: "waiting", moved: true }),
    ).toBe("speaking_turn_restored");
    expect(turnEventType({ from: "waiting", to: "waiting", moved: true })).toBe(
      "speaking_turn_moved",
    );
    expect(
      turnEventType({ from: "waiting", to: "waiting", moved: false }),
    ).toBe("speaking_turn_updated");
  });
});

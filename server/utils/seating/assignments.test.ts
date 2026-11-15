import { describe, expect, it } from "vitest";
import {
  emptySeatingLayout,
  type SeatingLayout,
} from "~~/shared/utils/seating/layout";
import { assignmentOps } from "~~/shared/utils/seating/proposal";
import {
  assignmentsLostByLayout,
  checkAssignmentBatch,
  releaseConfirmed,
  type AssignmentBatchInput,
} from "./assignments";

const seats = new Set(["s1", "s2", "s3", "s4"]);
const people = new Set(["ana", "bea", "carla", "dani"]);

const check = (
  ops: AssignmentBatchInput["ops"],
  current: AssignmentBatchInput["current"] = [],
) =>
  checkAssignmentBatch({
    ops,
    current,
    enabledSeats: seats,
    people,
  });

describe("checkAssignmentBatch", () => {
  it("places someone on an empty seat", () => {
    const result = check([{ seatId: "s1", expected: null, next: "ana" }]);
    expect(result).toEqual({
      ok: true,
      write: {
        // A seat seen empty is never deleted: a row someone else put there
        // meanwhile makes the insert fail instead.
        deletes: [],
        inserts: [{ seatId: "s1", personId: "ana" }],
        placed: 1,
        moved: 0,
        removed: 0,
        personIds: ["ana"],
      },
    });
  });

  it("swaps two people in one batch", () => {
    const current = [
      { seatId: "s1", personId: "ana" },
      { seatId: "s2", personId: "bea" },
    ];
    const ops = assignmentOps(current, [
      { seatId: "s1", personId: "bea" },
      { seatId: "s2", personId: "ana" },
    ]);
    const result = check(ops, current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.deletes).toEqual([
      { seatId: "s1", personId: "ana" },
      { seatId: "s2", personId: "bea" },
    ]);
    expect(result.write.inserts).toEqual([
      { seatId: "s1", personId: "bea" },
      { seatId: "s2", personId: "ana" },
    ]);
    expect(result.write).toMatchObject({ placed: 0, moved: 2, removed: 0 });
  });

  it("moves someone by emptying their seat in the same batch", () => {
    const current = [{ seatId: "s1", personId: "ana" }];
    const result = check(
      [
        { seatId: "s1", expected: "ana", next: null },
        { seatId: "s3", expected: null, next: "ana" },
      ],
      current,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write).toMatchObject({
      deletes: [{ seatId: "s1", personId: "ana" }],
      inserts: [{ seatId: "s3", personId: "ana" }],
      placed: 0,
      moved: 1,
      removed: 0,
    });
  });

  it("counts who is left without a seat", () => {
    const current = [
      { seatId: "s1", personId: "ana" },
      { seatId: "s2", personId: "bea" },
    ];
    const result = check(
      [
        { seatId: "s1", expected: "ana", next: null },
        { seatId: "s2", expected: "bea", next: "carla" },
      ],
      current,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write).toMatchObject({ placed: 1, moved: 0, removed: 2 });
    expect(result.write.personIds).toEqual(["ana", "bea", "carla"]);
  });

  it("refuses a seat that is not as the client saw it, naming who is there", () => {
    const result = check(
      [{ seatId: "s1", expected: null, next: "ana" }],
      [{ seatId: "s1", personId: "dani" }],
    );
    expect(result).toEqual({
      ok: false,
      conflict: {
        seats: [{ seatId: "s1", personId: "dani" }],
        unavailableSeatIds: [],
        unknownPersonIds: [],
      },
    });
  });

  it("refuses to seat someone twice: their seat must be emptied too", () => {
    const result = check(
      [{ seatId: "s2", expected: null, next: "ana" }],
      [{ seatId: "s1", personId: "ana" }],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict.seats).toEqual([{ seatId: "s1", personId: "ana" }]);
  });

  it("refuses someone the batch may not seat (gone, or needing no seat)", () => {
    const result = checkAssignmentBatch({
      ops: [{ seatId: "s1", expected: null, next: "ana" }],
      current: [],
      enabledSeats: seats,
      // «No necesita asiento»: out of the people the batch may seat.
      people: new Set(["bea"]),
    });
    expect(result).toEqual({
      ok: false,
      conflict: {
        seats: [],
        unavailableSeatIds: [],
        unknownPersonIds: ["ana"],
      },
    });
  });

  it("refuses seats the layout no longer has or disabled, and unknown people", () => {
    const result = check([
      { seatId: "gone", expected: null, next: "ana" },
      { seatId: "s2", expected: null, next: "nobody" },
    ]);
    expect(result).toEqual({
      ok: false,
      conflict: {
        seats: [],
        unavailableSeatIds: ["gone"],
        unknownPersonIds: ["nobody"],
      },
    });
  });

  it("lets a seat that is gone be emptied", () => {
    const result = check(
      [{ seatId: "gone", expected: "ana", next: null }],
      [{ seatId: "gone", personId: "ana" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write).toMatchObject({
      deletes: [{ seatId: "gone", personId: "ana" }],
      inserts: [],
      removed: 1,
    });
  });

  it("writes nothing for a batch that changes nothing", () => {
    const result = check(
      [{ seatId: "s1", expected: "ana", next: "ana" }],
      [{ seatId: "s1", personId: "ana" }],
    );
    expect(result).toEqual({
      ok: true,
      write: {
        deletes: [],
        inserts: [],
        placed: 0,
        moved: 0,
        removed: 0,
        personIds: [],
      },
    });
  });
});

describe("releaseConfirmed", () => {
  const shown = [
    { seatId: "s1", personId: "ana" },
    { seatId: "s2", personId: "bea" },
  ];

  it("takes a confirmation of who was shown, or of more", () => {
    expect(releaseConfirmed(shown, shown)).toBe(true);
    expect(releaseConfirmed([shown[0]!], shown)).toBe(true);
    expect(releaseConfirmed([], undefined)).toBe(true);
  });

  it("never stretches it to someone seated there since", () => {
    expect(
      releaseConfirmed([...shown, { seatId: "s3", personId: "carla" }], shown),
    ).toBe(false);
    // The same seat, someone else on it now.
    expect(releaseConfirmed([{ seatId: "s1", personId: "dani" }], shown)).toBe(
      false,
    );
    expect(releaseConfirmed(shown, undefined)).toBe(false);
    expect(releaseConfirmed(shown, [])).toBe(false);
  });
});

describe("assignmentsLostByLayout", () => {
  const layout = (disabled: boolean): SeatingLayout => ({
    ...emptySeatingLayout(),
    tables: [
      {
        id: "t1aaaaaaaaaaaaaaaaaaaaaa",
        shape: "rect",
        x: 0,
        y: 0,
        w: 180,
        h: 60,
        rotation: 0,
        zone: "delegates",
        run: "outer-u",
        seats: [
          { id: "s1", side: "front", index: 0 },
          { id: "s2", side: "front", index: 1, disabled },
        ],
      },
    ],
    chairs: [{ id: "c1", x: 0, y: 200, rotation: 0 }],
  });

  it("lists the occupied seats the layout removes or disables", () => {
    const assignments = [
      { seatId: "s2", personId: "bea" },
      { seatId: "c1", personId: "ana" },
      { seatId: "s9", personId: "carla" },
      { seatId: "s1", personId: "dani" },
    ];
    expect(assignmentsLostByLayout(layout(true), assignments)).toEqual([
      { seatId: "s2", personId: "bea" },
      { seatId: "s9", personId: "carla" },
    ]);
    expect(assignmentsLostByLayout(layout(false), assignments)).toEqual([
      { seatId: "s9", personId: "carla" },
    ]);
  });
});

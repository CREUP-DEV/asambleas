import { describe, expect, it } from "vitest";
import type {
  SeatingGroupDto,
  SeatingPersonDto,
  SeatingPlanDto,
} from "~~/shared/types/api";
import {
  emptySeatingLayout,
  layoutSeatIds,
  type SeatingLayout,
  type SeatingSeat,
  type SeatingTable,
} from "~~/shared/utils/seating/layout";
import { seatingWalk } from "~~/shared/utils/seating/runs";
import {
  DEFAULT_DOUBLE_U_PARAMS,
  defaultDoubleULayout,
} from "~~/shared/utils/seating/templates";
import {
  accountBlocks,
  affectsSeating,
  doubleUProblem,
  facingVector,
  fitFontSize,
  freeChairSpot,
  isFreeSpot,
  labelPlacement,
  normalizeSearch,
  personInitials,
  personName,
  readableAngle,
  regenerateKeepingIds,
  sameLayout,
  sameToken,
  searchSeating,
  seatNameKey,
  seatingRefusal,
  seatViews,
  stadiumPath,
  syncDue,
} from "./-model";

const AT = "2026-11-15T10:00:00.000Z";

const group = (over: Partial<SeatingGroupDto> & { id: string }) =>
  ({
    source: "intranet",
    kind: "asociado",
    intranetType: "Asociado",
    category: "multiuser",
    acronym: over.id.toUpperCase(),
    name: `Consejo ${over.id}`,
    member: null,
    imageUrl: null,
    order: null,
    goneAt: null,
    updatedAt: AT,
    ...over,
  }) satisfies SeatingGroupDto;

const person = (over: Partial<SeatingPersonDto> & { id: string }) =>
  ({
    groupId: "g1",
    source: "intranet",
    firstName: "Lucía",
    surname: "Ferrán Oca",
    label: null,
    status: "confirmed",
    needsSeat: true,
    goneAt: null,
    userId: null,
    photoUrl: null,
    position: 0,
    updatedAt: AT,
    ...over,
  }) satisfies SeatingPersonDto;

const seats = (prefix: string, count: number, disabled: number[] = []) =>
  Array.from({ length: count }, (_, index): SeatingSeat => ({
    id: `${prefix}${index}`,
    side: "front",
    index,
    ...(disabled.includes(index) ? { disabled: true } : {}),
  }));

const table = (
  id: string,
  x: number,
  y: number,
  rotation: number,
  tableSeats: SeatingSeat[],
  run = "row",
): SeatingTable => ({
  id,
  shape: "rect",
  x,
  y,
  w: 180,
  h: 60,
  rotation,
  zone: "delegates",
  run,
  seats: tableSeats,
});

/** One run that turns a corner: a table facing down, then one turned. */
const layout: SeatingLayout = {
  ...emptySeatingLayout(),
  tables: [
    table("t1", 0, 0, 0, seats("a", 3)),
    table("t2", 300, 200, 90, seats("b", 3, [1])),
  ],
  chairs: [{ id: "c0", x: 1000, y: 1000, rotation: 0 }],
};
const walk = seatingWalk(layout);

const plan = (
  assignments: SeatingPlanDto["assignments"],
  people: SeatingPersonDto[],
  groups: SeatingGroupDto[],
) => ({ groups, people, assignments });

describe("seatViews", () => {
  it("lists every seat in walk order with its occupant and colour", () => {
    const groups = [
      group({ id: "g1" }),
      group({ id: "g2", kind: "sectorial", intranetType: "Sectorial" }),
      group({ id: "g3", kind: "cea", intranetType: "CAS" }),
    ];
    const people = [
      person({ id: "p1", groupId: "g1" }),
      person({ id: "p2", groupId: "g2" }),
      person({ id: "p3", groupId: "g3" }),
    ];
    const views = seatViews(
      layout,
      walk,
      plan(
        [
          { seatId: "a1", personId: "p1" },
          { seatId: "b0", personId: "p2" },
          { seatId: "c0", personId: "p3" },
        ],
        people,
        groups,
      ),
    );
    expect(views.map((seat) => seat.id)).toEqual([
      "a0",
      "a1",
      "a2",
      "b0",
      "b1",
      "b2",
      "c0",
    ]);
    expect(views[1]!.occupant?.person.id).toBe("p1");
    expect(views[1]!.occupant?.colour).toBe("info");
    expect(views[3]!.occupant?.colour).toBe("sectorial");
    // The CAS keeps the CEA's kind and is green all the same.
    expect(views[6]!.occupant?.colour).toBe("sectorial");
    expect(views[4]!.disabled).toBe(true);
    expect(views[6]!.tableId).toBeNull();
  });
});

describe("accountBlocks", () => {
  const groups = [group({ id: "g1" }), group({ id: "g2" })];
  const people = [
    person({ id: "p1" }),
    person({ id: "p2" }),
    person({ id: "p3", status: "pending" }),
    person({ id: "p4" }),
    person({ id: "q1", groupId: "g2" }),
  ];

  it("makes one block per table of a run that turns a corner", () => {
    const views = seatViews(
      layout,
      walk,
      plan(
        [
          { seatId: "a1", personId: "p1" },
          { seatId: "a2", personId: "p2" },
          { seatId: "b0", personId: "p3" },
          // Past a disabled seat: still the same block.
          { seatId: "b2", personId: "p4" },
          { seatId: "c0", personId: "q1" },
        ],
        people,
        groups,
      ),
    );
    const blocks = accountBlocks(walk, views);
    expect(blocks.map((block) => block.seatIds)).toEqual([
      ["a1", "a2"],
      ["b0", "b2"],
      ["c0"],
    ]);
    expect(blocks[0]!.pending).toBe(false);
    expect(blocks[1]!.pending).toBe(true);
    // An even block's centre lies between its two middle seats.
    const [a1, a2] = [views[1]!, views[2]!];
    expect(blocks[0]!.centre).toEqual({
      x: (a1.x + a2.x) / 2,
      y: (a1.y + a2.y) / 2,
    });
    // A loose chair's label goes below it, flat.
    expect(blocks[2]!.label.angle).toBe(0);
    expect(blocks[2]!.label.y).toBeGreaterThan(1000);
  });

  it("splits a group whose seats are apart", () => {
    const views = seatViews(
      layout,
      walk,
      plan(
        [
          { seatId: "a0", personId: "p1" },
          { seatId: "a2", personId: "p2" },
        ],
        people,
        groups,
      ),
    );
    expect(accountBlocks(walk, views).map((block) => block.seatIds)).toEqual([
      ["a0"],
      ["a2"],
    ]);
  });
});

describe("labels", () => {
  it("turns text along a table's edge and never upside down", () => {
    expect(readableAngle(0)).toBe(0);
    expect(readableAngle(90)).toBe(90);
    expect(readableAngle(180)).toBe(0);
    expect(readableAngle(270)).toBe(90);
    expect(readableAngle(300)).toBe(-60);
  });

  it("writes a seat's label on the table side", () => {
    // A seat facing up the page has its table above it.
    const label = labelPlacement({ x: 0, y: 100, facing: 0 }, true);
    expect(label.x).toBe(0);
    expect(label.y).toBeLessThan(100);
    const right = facingVector(90);
    expect(right).toEqual({ x: 1, y: 0 });
  });
});

describe("shapes", () => {
  it("draws a capsule along its seats, or a circle for one", () => {
    expect(
      stadiumPath(
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        20,
      ),
    ).toBe(
      "M 0 20 L 100 20 A 20 20 0 0 0 100 -20 L 0 -20 A 20 20 0 0 0 0 20 Z",
    );
    expect(stadiumPath([{ x: 10, y: 10 }], 5)).toBe(
      "M 5 10 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 Z",
    );
    expect(stadiumPath([], 5)).toBe("");
  });

  it("fits a text's size between its limits", () => {
    expect(fitFontSize("UGR", 40, 14)).toBe(14);
    expect(fitFontSize("CdEUPM", 40, 14)).toBe(10.8);
    expect(fitFontSize("ABCDEFGHIJKLMNOPQRST", 40, 14)).toBe(7);
  });
});

describe("people", () => {
  it("takes the initials of the first name and the first surname", () => {
    expect(personInitials({ firstName: "lucía", surname: "Ferrán Oca" })).toBe(
      "LF",
    );
    expect(personInitials({ firstName: "Íñigo", surname: null })).toBe("Í");
    expect(personInitials({ firstName: null, surname: null })).toBeNull();
  });

  it("names a person, or nobody for a seat kept without a name", () => {
    expect(personName({ firstName: "Lucía", surname: " Oca " })).toBe(
      "Lucía Oca",
    );
    expect(personName({ firstName: null, surname: null })).toBeNull();
  });
});

describe("searchSeating", () => {
  const groups = [
    group({ id: "g1", acronym: "UGR", name: "Consejo de Estudiantes" }),
    group({ id: "g2", acronym: "ANEM" }),
  ];
  const people = [
    person({ id: "p1", firstName: "Lucía", surname: "Ferrán" }),
    person({ id: "p2", firstName: "Mateo", surname: "Ríos" }),
    person({ id: "p3", firstName: "Lucas", surname: "Pardo" }),
    person({ id: "p4", groupId: "g2", firstName: "Nora", surname: "Vidal" }),
    person({
      id: "p5",
      groupId: "g2",
      firstName: "Lucía",
      surname: "Gil",
      needsSeat: false,
    }),
  ];
  const assignments = [
    { seatId: "a0", personId: "p1" },
    { seatId: "a1", personId: "p2" },
    { seatId: "b0", personId: "p4" },
  ];
  const views = seatViews(layout, walk, plan(assignments, people, groups));
  const parts = plan(assignments, people, groups);

  it("matches names without accents or case, word by word", () => {
    expect(searchSeating("lucia", views, parts)).toEqual({
      seatIds: ["a0"],
      unseated: 0,
    });
    expect(searchSeating("ugr rios", views, parts).seatIds).toEqual(["a1"]);
  });

  it("matches an account and counts its people without a seat", () => {
    expect(searchSeating("ugr", views, parts)).toEqual({
      seatIds: ["a0", "a1"],
      unseated: 1,
    });
  });

  it("matches nothing for an empty query", () => {
    expect(searchSeating("  ", views, parts)).toEqual({
      seatIds: [],
      unseated: 0,
    });
    expect(normalizeSearch("  Ángel   Núñez ")).toBe("angel nunez");
  });
});

describe("loose chairs", () => {
  it("puts a chair where it was asked when that spot is free", () => {
    expect(freeChairSpot(layout, { x: 2004, y: -1996 })).toEqual({
      x: 2000,
      y: -2000,
    });
  });

  it("moves it off a table and away from other seats", () => {
    const spot = freeChairSpot(layout, { x: 0, y: 0 });
    expect(isFreeSpot(layout, spot)).toBe(true);
    expect(Math.abs(spot.x % 10)).toBe(0);
    expect(Math.abs(spot.y % 10)).toBe(0);
    expect(isFreeSpot(layout, { x: 0, y: 0 })).toBe(false);
    // Too close to the loose chair.
    expect(isFreeSpot(layout, { x: 1030, y: 1000 })).toBe(false);
    expect(isFreeSpot(layout, { x: 1030, y: 1000 }, "c0")).toBe(true);
  });
});

describe("regenerateKeepingIds", () => {
  let next = 0;
  const createId = () => `id${String((next += 1)).padStart(22, "0")}`;
  const saved = defaultDoubleULayout({ createId });
  const doubleU = (over: Partial<typeof DEFAULT_DOUBLE_U_PARAMS>) => ({
    kind: "double_u" as const,
    params: { ...DEFAULT_DOUBLE_U_PARAMS, ...over },
  });

  it("keeps every saved seat id through a round trip of a number", () => {
    const fewer = regenerateKeepingIds(
      saved,
      saved,
      doubleU({ seatsPerTable: 2 }),
    );
    expect(layoutSeatIds(fewer).length).toBeLessThan(
      layoutSeatIds(saved).length,
    );
    const back = regenerateKeepingIds(
      fewer,
      saved,
      doubleU({ seatsPerTable: 3 }),
    );
    expect(layoutSeatIds(back)).toEqual(layoutSeatIds(saved));
    expect(sameLayout(back, saved)).toBe(true);
  });

  it("brings back whole tables the draft had dropped", () => {
    const shorter = regenerateKeepingIds(
      saved,
      saved,
      doubleU({ outerArmTables: 6 }),
    );
    const back = regenerateKeepingIds(
      shorter,
      saved,
      doubleU({ outerArmTables: 7 }),
    );
    expect(back.tables.map((entry) => entry.id)).toEqual(
      saved.tables.map((entry) => entry.id),
    );
  });

  it("keeps the draft's own changes over the saved room", () => {
    const draft: SeatingLayout = {
      ...saved,
      tables: saved.tables.map((entry, index) =>
        index === 1
          ? {
              ...entry,
              seats: entry.seats.map((seat, k) =>
                k === 0 ? { ...seat, disabled: true } : seat,
              ),
            }
          : entry,
      ),
    };
    const again = regenerateKeepingIds(draft, saved, doubleU({}));
    expect(again.tables[1]!.seats[0]!.disabled).toBe(true);
  });

  it("works without a saved room", () => {
    const fresh = regenerateKeepingIds(saved, null, doubleU({ mesaSeats: 4 }));
    expect(fresh.tables[0]!.seats).toHaveLength(4);
  });
});

describe("doubleUProblem", () => {
  it("accepts the default numbers", () => {
    expect(doubleUProblem(DEFAULT_DOUBLE_U_PARAMS)).toBeNull();
  });

  it("names the number out of its limits", () => {
    expect(
      doubleUProblem({ ...DEFAULT_DOUBLE_U_PARAMS, mesaSeats: 9 }),
    ).toEqual({
      field: "mesaSeats",
      key: "seating.doubleU.problems.range",
      values: { min: 3, max: 5 },
    });
    expect(doubleUProblem({ ...DEFAULT_DOUBLE_U_PARAMS, gap: 155 })?.key).toBe(
      "seating.doubleU.problems.gapStep",
    );
  });

  it("asks for two more tables on the outer base than the inner", () => {
    expect(
      doubleUProblem({
        ...DEFAULT_DOUBLE_U_PARAMS,
        outerBaseTables: 5,
        innerBaseTables: 4,
      }),
    ).toEqual({
      field: "outerBaseTables",
      key: "seating.doubleU.problems.base",
      values: { count: 6 },
    });
    // Without an inner U the base takes any number.
    expect(
      doubleUProblem({
        ...DEFAULT_DOUBLE_U_PARAMS,
        outerBaseTables: 1,
        innerArmTables: 0,
        innerBaseTables: 0,
      }),
    ).toBeNull();
  });
});

describe("sameLayout and sameToken", () => {
  it("ignores the order of keys, never the order of seats", () => {
    const a = defaultDoubleULayout();
    const reordered = JSON.parse(
      JSON.stringify(a, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    ) as SeatingLayout;
    expect(sameLayout(a, reordered)).toBe(true);
    const swapped: SeatingLayout = {
      ...a,
      tables: [a.tables[1]!, a.tables[0]!, ...a.tables.slice(2)],
    };
    expect(sameLayout(a, swapped)).toBe(false);
    expect(sameLayout(null, null)).toBe(true);
    expect(sameLayout(a, null)).toBe(false);
  });

  it("compares lock tokens as instants", () => {
    expect(sameToken(AT, "2026-11-15T11:00:00.000+01:00")).toBe(true);
    expect(sameToken(AT, "2026-11-15T10:00:00.001Z")).toBe(false);
    expect(sameToken(null, null)).toBe(true);
    expect(sameToken(AT, null)).toBe(false);
  });
});

describe("seatingRefusal", () => {
  it("reads the data of a refusal with the reason asked for", () => {
    const error = {
      statusCode: 409,
      data: { data: { reason: "seating_stale", layoutUpdatedAt: AT } },
    };
    expect(seatingRefusal(error, "seating_stale")).toEqual({
      reason: "seating_stale",
      layoutUpdatedAt: AT,
    });
    expect(seatingRefusal(error, "seating_seats_occupied")).toBeNull();
    expect(seatingRefusal(new Error("network"), "seating_stale")).toBeNull();
    expect(seatingRefusal(null, "seating_stale")).toBeNull();
  });
});

describe("words and timing", () => {
  it("names a seat by its run", () => {
    expect(seatNameKey("outer_u")).toBe("seating.seat.name.outerU");
    expect(seatNameKey("other")).toBe("seating.seat.name.other");
  });

  it("reads the Intranet again after ten minutes", () => {
    const now = Date.parse(AT);
    expect(syncDue(null, now)).toBe(true);
    expect(syncDue("2026-11-15T09:55:00.000Z", now)).toBe(false);
    expect(syncDue("2026-11-15T09:49:00.000Z", now)).toBe(true);
    expect(syncDue("not a date", now)).toBe(true);
  });

  it("refetches on the room's own events and on a poll", () => {
    expect(
      affectsSeating([{ type: "seating_synced", entityType: "seating" }]),
    ).toBe(true);
    expect(affectsSeating([{ type: "poll", entityType: "assembly" }])).toBe(
      true,
    );
    expect(
      affectsSeating([{ type: "document_updated", entityType: "document" }]),
    ).toBe(false);
  });
});

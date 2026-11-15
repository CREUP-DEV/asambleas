import { describe, expect, it } from "vitest";
import type {
  SeatingGroupDto,
  SeatingPersonDto,
  SeatingPlanDto,
} from "~~/shared/types/api";
import {
  emptySeatingLayout,
  type SeatingLayout,
  type SeatingSeat,
  type SeatingTable,
} from "~~/shared/utils/seating/layout";
import { seatingWalk } from "~~/shared/utils/seating/runs";
import { seatViews } from "./-model";
import {
  applyPlacement,
  assignSeat,
  filterTray,
  listRuns,
  personPick,
  placementTarget,
  seatRanges,
  trayGroups,
  trayKinds,
  trayPick,
  traySection,
  traySections,
  unitAt,
  unseatPeople,
  type SeatingPick,
} from "./-placing";

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
    firstName: "Ana",
    surname: "Pérez Inventada",
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
  tableSeats: SeatingSeat[],
  run = "outer-u",
): SeatingTable => ({
  id,
  shape: "rect",
  x,
  y: 0,
  w: 180,
  h: 60,
  rotation: 0,
  zone: "delegates",
  run,
  seats: tableSeats,
});

/**
 * The outer U: a0 a1 a2 | b0 b1(disabled) b2 | c0 c1 c2, then the inner U
 * (d0 d1 d2) and two loose chairs.
 */
const layout: SeatingLayout = {
  ...emptySeatingLayout(),
  tables: [
    table("ta", 0, seats("a", 3)),
    table("tb", 200, seats("b", 3, [1])),
    table("tc", 400, seats("c", 3)),
    table("td", 0, seats("d", 3), "inner-u"),
  ],
  chairs: [
    { id: "x0", x: 1000, y: 1000, rotation: 0 },
    { id: "x1", x: 1100, y: 1000, rotation: 0 },
  ],
};
const walk = seatingWalk(layout);

type Plan = Pick<SeatingPlanDto, "groups" | "people" | "assignments">;

const groups = [
  group({ id: "g1", acronym: "UGR" }),
  group({ id: "g2", acronym: "UMA" }),
  group({
    id: "g3",
    acronym: "ANEM",
    kind: "sectorial",
    intranetType: "Sectorial",
  }),
];

/** g1: p1 p2 p3; g2: q1 q2; g3: s1. */
const people = [
  person({ id: "p1", groupId: "g1", position: 0 }),
  person({ id: "p2", groupId: "g1", position: 1 }),
  person({ id: "p3", groupId: "g1", position: 2 }),
  person({ id: "q1", groupId: "g2", position: 0, firstName: "Irene" }),
  person({ id: "q2", groupId: "g2", position: 1 }),
  person({ id: "s1", groupId: "g3", position: 0, label: "Coordinación" }),
];

const plan = (assignments: Plan["assignments"], extra: Partial<Plan> = {}) =>
  ({ groups, people, assignments, ...extra }) satisfies Plan;

const pick = (personIds: string[], groupId = "g1", swap = false) =>
  ({ groupId, personIds, swap }) satisfies SeatingPick;

describe("the tray", () => {
  it("sorts groups into sections by how many of them have a seat", () => {
    const entries = trayGroups(
      plan([
        { seatId: "a0", personId: "p1" },
        { seatId: "c0", personId: "q1" },
        { seatId: "c1", personId: "q2" },
      ]),
    );
    const byId = new Map(entries.map((entry) => [entry.group.id, entry]));
    expect(byId.get("g1")!.section).toBe("partly");
    expect(byId.get("g1")!.counts).toEqual({ total: 3, seated: 1, pending: 0 });
    expect(byId.get("g1")!.unseatedIds).toEqual(["p2", "p3"]);
    expect(byId.get("g2")!.section).toBe("seated");
    expect(byId.get("g3")!.section).toBe("unseated");
    const sections = traySections(entries);
    expect(sections.unseated.map((entry) => entry.group.id)).toEqual(["g3"]);
    expect(sections.partly.map((entry) => entry.group.id)).toEqual(["g1"]);
  });

  it("keeps groups with nobody left to seat in «Sentados»", () => {
    expect(traySection({ total: 0, seated: 0, pending: 0 })).toBe("seated");
    const entries = trayGroups(
      plan([], {
        groups: [
          ...groups,
          group({ id: "g4", source: "manual", acronym: "Prensa" }),
          group({ id: "g5", goneAt: AT }),
        ],
        people: [
          ...people,
          person({ id: "r1", groupId: "g5" }),
          person({ id: "t1", groupId: "g3", needsSeat: false, position: 1 }),
        ],
      }),
    );
    const byId = new Map(entries.map((entry) => [entry.group.id, entry]));
    expect(byId.get("g4")!.section).toBe("seated");
    expect(byId.get("g5")!.section).toBe("seated");
    expect(byId.get("g5")!.people[0]!.counts).toBe(false);
    // Someone who needs no seat is listed but never picked.
    expect(byId.get("g3")!.unseatedIds).toEqual(["s1"]);
  });

  it("filters by kind and search, narrowing a group to the people who match", () => {
    const entries = trayGroups(plan([]));
    expect(trayKinds(entries)).toEqual(["asociado", "sectorial"]);
    expect(
      filterTray(entries, { query: "", kind: "sectorial" }).map(
        (entry) => entry.group.id,
      ),
    ).toEqual(["g3"]);
    const byName = filterTray(entries, { query: "ugr", kind: null });
    expect(byName.map((entry) => entry.group.id)).toEqual(["g1"]);
    expect(byName[0]!.narrowed).toBe(false);
    const byPerson = filterTray(entries, { query: "irene", kind: null });
    expect(byPerson.map((entry) => entry.group.id)).toEqual(["g2"]);
    expect(byPerson[0]!.narrowed).toBe(true);
    expect(byPerson[0]!.people.map((item) => item.person.id)).toEqual(["q1"]);
    // Every word, across the group and the person, accents aside.
    expect(
      filterTray(entries, { query: "anem coordinacion", kind: null }).map(
        (entry) => entry.group.id,
      ),
    ).toEqual(["g3"]);
    expect(filterTray(entries, { query: "nadie", kind: null })).toEqual([]);
  });
});

describe("picking", () => {
  it("picks a row's people without a seat, or the whole account to move it", () => {
    const entries = trayGroups(
      plan([
        { seatId: "c1", personId: "q2" },
        { seatId: "a2", personId: "q1" },
        { seatId: "a0", personId: "p1" },
      ]),
    );
    const byId = new Map(entries.map((entry) => [entry.group.id, entry]));
    expect(trayPick(walk, byId.get("g1")!)).toEqual(pick(["p2", "p3"]));
    // Everyone seated: all of them, in seat order.
    expect(trayPick(walk, byId.get("g2")!)).toEqual(pick(["q1", "q2"], "g2"));
  });

  it("picks one person, never someone who neither needs nor has a seat", () => {
    const [entry] = trayGroups(
      plan([], {
        people: [person({ id: "p1", needsSeat: false })],
        groups: [groups[0]!],
      }),
    );
    expect(personPick(entry!.people[0]!)).toBeNull();
    const other = trayGroups(plan([])).find((entry) => entry.group.id === "g1");
    expect(personPick(other!.people[1]!)).toEqual(pick(["p2"]));
  });

  it("picks the block in «Cuentas» and the person in «Asistentes»", () => {
    const room = plan([
      { seatId: "a1", personId: "p1" },
      { seatId: "a2", personId: "p2" },
      // b1 is disabled: b0 and b2 still sit together with a1 and a2.
      { seatId: "b0", personId: "p3" },
      { seatId: "d0", personId: "q1" },
    ]);
    expect(unitAt(walk, room, "a2", "accounts")).toEqual(
      pick(["p1", "p2", "p3"]),
    );
    expect(unitAt(walk, room, "a2", "people")).toEqual(pick(["p2"]));
    expect(unitAt(walk, room, "a0", "accounts")).toBeNull();
  });

  it("splits an account's seats that are not together into blocks", () => {
    const room = plan([
      { seatId: "a0", personId: "p1" },
      { seatId: "c2", personId: "p2" },
    ]);
    expect(unitAt(walk, room, "c2", "accounts")).toEqual(pick(["p2"]));
  });
});

describe("placementTarget", () => {
  it("takes the seats in a row from the target, passing disabled seats", () => {
    const target = placementTarget(
      walk,
      plan([]),
      pick(["p1", "p2", "p3"]),
      "a2",
      "accounts",
    );
    expect(target).toEqual({
      seatIds: ["a2", "b0", "b2"],
      fits: true,
      displaced: [],
      swap: false,
    });
  });

  it("slides back when the run ends first", () => {
    expect(
      placementTarget(walk, plan([]), pick(["p1", "p2"]), "c2", "accounts")
        ?.seatIds,
    ).toEqual(["c1", "c2"]);
  });

  it("never lands on both sides of someone: it fits the free stretch or is short", () => {
    const room = plan([{ seatId: "a2", personId: "s1" }]);
    // a0 a1 | s1 | b0 b2 …: from a0, only two seats before ANEM.
    const short = placementTarget(
      walk,
      room,
      pick(["p1", "p2", "p3"]),
      "a0",
      "accounts",
    );
    expect(short).toEqual({
      seatIds: ["a0", "a1"],
      fits: false,
      displaced: [],
      swap: false,
    });
    // From a1, the stretch a0 a1 still holds two: the window slides back.
    expect(
      placementTarget(walk, room, pick(["p1", "p2"]), "a1", "accounts")
        ?.seatIds,
    ).toEqual(["a0", "a1"]);
  });

  it("counts the pick's own seats as free when it moves", () => {
    const room = plan([
      { seatId: "a0", personId: "p1" },
      { seatId: "a1", personId: "p2" },
      { seatId: "a2", personId: "s1" },
    ]);
    // UGR moves one seat back onto itself: a1 is its own.
    expect(
      placementTarget(walk, room, pick(["p1", "p2"]), "a1", "accounts"),
    ).toEqual({
      seatIds: ["a0", "a1"],
      fits: true,
      displaced: [],
      swap: false,
    });
  });

  it("swaps with a block of the same size, and asks otherwise", () => {
    const room = plan([
      { seatId: "a0", personId: "p1" },
      { seatId: "a1", personId: "p2" },
      { seatId: "c0", personId: "q1" },
      { seatId: "c1", personId: "q2" },
      { seatId: "d0", personId: "s1" },
    ]);
    expect(
      placementTarget(walk, room, pick(["p1", "p2"]), "c1", "accounts"),
    ).toEqual({
      seatIds: ["c0", "c1"],
      fits: true,
      displaced: ["q1", "q2"],
      swap: true,
    });
    // ANEM (one) onto UMA (two): no swap; the page asks.
    expect(
      placementTarget(walk, room, pick(["s1"], "g3"), "c0", "accounts"),
    ).toEqual({ seatIds: ["c0"], fits: true, displaced: ["q1"], swap: false });
    // From the tray nothing swaps.
    expect(
      placementTarget(walk, room, pick(["p3"]), "d0", "people")?.swap,
    ).toBe(false);
    // One person onto another in «Asistentes».
    expect(placementTarget(walk, room, pick(["p1"]), "c1", "people")).toEqual({
      seatIds: ["c1"],
      fits: true,
      displaced: ["q2"],
      swap: true,
    });
  });

  it("puts one person on a loose chair, and refuses disabled seats", () => {
    expect(
      placementTarget(walk, plan([]), pick(["p1", "p2"]), "x1", "accounts"),
    ).toEqual({ seatIds: ["x1"], fits: false, displaced: [], swap: false });
    expect(
      placementTarget(walk, plan([]), pick(["p1"]), "b1", "accounts"),
    ).toBeNull();
    expect(
      placementTarget(walk, plan([]), pick([]), "a0", "accounts"),
    ).toBeNull();
  });
});

describe("applyPlacement", () => {
  it("places a pick from the tray on free seats", () => {
    const room = plan([{ seatId: "c0", personId: "q1" }]);
    const target = placementTarget(
      walk,
      room,
      pick(["p1", "p2"]),
      "a0",
      "accounts",
    )!;
    const result = applyPlacement(
      walk,
      room.assignments,
      pick(["p1", "p2"]),
      target,
    );
    expect(result.assignments).toEqual([
      { seatId: "a0", personId: "p1" },
      { seatId: "a1", personId: "p2" },
      { seatId: "c0", personId: "q1" },
    ]);
    expect(result.placed).toHaveLength(2);
    expect(result.unseated).toEqual([]);
  });

  it("places the ones that fit and leaves the rest where they were", () => {
    const room = plan([
      { seatId: "a2", personId: "s1" },
      { seatId: "d2", personId: "p3" },
    ]);
    const chosen = pick(["p1", "p2", "p3"]);
    const target = placementTarget(walk, room, chosen, "a0", "accounts")!;
    expect(target.fits).toBe(false);
    const result = applyPlacement(walk, room.assignments, chosen, target);
    expect(result.assignments).toEqual([
      { seatId: "a0", personId: "p1" },
      { seatId: "a1", personId: "p2" },
      { seatId: "a2", personId: "s1" },
      { seatId: "d2", personId: "p3" },
    ]);
  });

  it("swaps two blocks of the same size", () => {
    const room = plan([
      { seatId: "a0", personId: "p1" },
      { seatId: "a1", personId: "p2" },
      { seatId: "c0", personId: "q1" },
      { seatId: "c1", personId: "q2" },
    ]);
    const chosen = pick(["p1", "p2"]);
    const target = placementTarget(walk, room, chosen, "c0", "accounts")!;
    const result = applyPlacement(walk, room.assignments, chosen, target);
    expect(result.assignments).toEqual([
      { seatId: "a0", personId: "q1" },
      { seatId: "a1", personId: "q2" },
      { seatId: "c0", personId: "p1" },
      { seatId: "c1", personId: "p2" },
    ]);
    expect(result.moved).toHaveLength(2);
    expect(result.unseated).toEqual([]);
  });

  it("«Intercambiar» sends the displaced to the seats left, the rest to the tray", () => {
    const room = plan([
      { seatId: "a0", personId: "s1" },
      { seatId: "c0", personId: "p1" },
      { seatId: "c1", personId: "p2" },
    ]);
    // ANEM (one) onto UGR's block of two.
    const chosen = pick(["s1"], "g3");
    const target = placementTarget(walk, room, chosen, "c0", "accounts")!;
    expect(target.swap).toBe(false);
    expect(target.displaced).toEqual(["p1"]);
    const swapped = applyPlacement(
      walk,
      room.assignments,
      chosen,
      target,
      "swap",
    );
    expect(swapped.assignments).toEqual([
      { seatId: "a0", personId: "p1" },
      { seatId: "c0", personId: "s1" },
      { seatId: "c1", personId: "p2" },
    ]);
    // Two onto one: one of the displaced has no seat left.
    const two = pick(["p1", "q2"], "g1");
    const over = plan([
      { seatId: "a0", personId: "s1" },
      { seatId: "c1", personId: "p1" },
      { seatId: "c2", personId: "q2" },
      { seatId: "d0", personId: "q1" },
      { seatId: "d1", personId: "p2" },
    ]);
    const onto = placementTarget(walk, over, two, "d0", "people")!;
    expect(onto.displaced).toEqual(["q1", "p2"]);
    const result = applyPlacement(walk, over.assignments, two, onto, "swap");
    expect(result.moved).toEqual([
      { seatId: "c1", personId: "q1" },
      { seatId: "c2", personId: "p2" },
    ]);
  });

  it("«Desplazar» sends the people there back to the tray", () => {
    const room = plan([{ seatId: "a0", personId: "s1" }]);
    const chosen = pick(["p1"]);
    const target = placementTarget(walk, room, chosen, "a0", "people")!;
    const result = applyPlacement(
      walk,
      room.assignments,
      chosen,
      target,
      "displace",
    );
    expect(result.assignments).toEqual([{ seatId: "a0", personId: "p1" }]);
    expect(result.unseated).toEqual(["s1"]);
  });
});

describe("unseating and assigning", () => {
  const room = plan([
    { seatId: "a0", personId: "p1" },
    { seatId: "a1", personId: "p2" },
    { seatId: "c0", personId: "q1" },
  ]);

  it("unseats people", () => {
    const result = unseatPeople(walk, room.assignments, ["p1", "p2"]);
    expect(result.assignments).toEqual([{ seatId: "c0", personId: "q1" }]);
    expect(result.unseated).toEqual(["p1", "p2"]);
  });

  it("assigns a seat, swapping with whoever was there when the person had a seat", () => {
    expect(assignSeat(walk, room.assignments, "c0", "p1").assignments).toEqual([
      { seatId: "a0", personId: "q1" },
      { seatId: "a1", personId: "p2" },
      { seatId: "c0", personId: "p1" },
    ]);
    const fromTray = assignSeat(walk, room.assignments, "c0", "s1");
    expect(fromTray.unseated).toEqual(["q1"]);
    const emptied = assignSeat(walk, room.assignments, "a1", null);
    expect(emptied.unseated).toEqual(["p2"]);
    expect(assignSeat(walk, room.assignments, "a0", "p1").assignments).toEqual(
      room.assignments,
    );
  });
});

describe("seatRanges", () => {
  it("words stretches by run, passing disabled seats, and each loose chair alone", () => {
    expect(seatRanges(walk, ["b2", "a2", "b0", "d1", "x0", "x1"])).toEqual([
      { kind: "outer_u", ordinal: 1, from: 3, to: 6 },
      { kind: "inner_u", ordinal: 1, from: 2, to: 2 },
      { kind: "loose", ordinal: 1, from: 1, to: 1 },
      { kind: "loose", ordinal: 1, from: 2, to: 2 },
    ]);
    expect(seatRanges(walk, ["nope"])).toEqual([]);
  });
});

describe("listRuns", () => {
  it("lists seats by run and table, with each table's numbers", () => {
    const views = seatViews(layout, walk, plan([]));
    const runs = listRuns(walk, views);
    expect(runs.map((run) => [run.kind, run.tables.length])).toEqual([
      ["outer_u", 3],
      ["inner_u", 1],
      ["loose", 1],
    ]);
    expect(runs[0]!.tables[1]).toMatchObject({ key: "tb", from: 4, to: 6 });
    expect(runs[2]!.tables[0]).toMatchObject({ key: "loose", from: 1, to: 2 });
  });
});

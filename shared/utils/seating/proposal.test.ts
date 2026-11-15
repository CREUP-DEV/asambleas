import { describe, expect, it } from "vitest";
import type {
  SeatAssignment,
  SeatingGroupInput,
  SeatingPersonInput,
} from "./groups";
import {
  emptySeatingLayout,
  type SeatingLayout,
  type SeatingTable,
} from "./layout";
import {
  assignmentOps,
  proposeSeating,
  type SeatingProposalInput,
} from "./proposal";
import { SEATING_RUNS, seatingWalk } from "./runs";
import { defaultDoubleULayout } from "./templates";

const table = (
  id: string,
  run: string,
  zone: SeatingTable["zone"],
  seatIds: string[],
): SeatingTable => ({
  id,
  shape: "rect",
  x: 0,
  y: 0,
  w: 180,
  h: 60,
  rotation: 0,
  zone,
  run,
  seats: seatIds.map((seatId, index) => ({
    id: seatId,
    side: "front",
    index,
  })),
});

/**
 * The Mesa (m0-m4); a U whose arms (L, R) are the delegations' and whose
 * base (B0-B5) is the CEA's; an inner row (V0-V3); a free table and a loose
 * chair nobody is placed on.
 */
const layout: SeatingLayout = {
  ...emptySeatingLayout(),
  tables: [
    table("m", SEATING_RUNS.presiding, "presiding", [
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]),
    table("l", SEATING_RUNS.outerU, "delegates", ["L0", "L1", "L2"]),
    table("b1", SEATING_RUNS.outerU, "cea", ["B0", "B1", "B2"]),
    table("b2", SEATING_RUNS.outerU, "cea", ["B3", "B4", "B5"]),
    table("r", SEATING_RUNS.outerU, "delegates", ["R0", "R1", "R2"]),
    table("v", SEATING_RUNS.innerU, "delegates", ["V0", "V1", "V2", "V3"]),
    table("f", "free-row", "free", ["F0", "F1"]),
  ],
  chairs: [{ id: "c0", x: 0, y: 0, rotation: 0 }],
};

const group = (
  id: string,
  over: Partial<SeatingGroupInput> = {},
): SeatingGroupInput => ({
  id,
  kind: "other",
  intranetType: null,
  acronym: id.toUpperCase(),
  name: id,
  order: null,
  goneAt: null,
  ...over,
});

/** `count` people of a group: `<group>-1`, `<group>-2`... */
const peopleOf = (
  groupId: string,
  count: number,
  over: Partial<SeatingPersonInput> = {},
): SeatingPersonInput[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${groupId}-${index + 1}`,
    groupId,
    needsSeat: true,
    goneAt: null,
    position: index,
    ...over,
  }));

const groups: SeatingGroupInput[] = [
  group("mesa", { kind: "mesa" }),
  group("se", { kind: "cea", acronym: "SE", intranetType: "CEA", order: 2 }),
  group("pres", {
    kind: "cea",
    acronym: "PRES",
    intranetType: "CEA",
    order: 1,
  }),
  group("tes", { kind: "cea", acronym: "TES", intranetType: "CEA", order: 3 }),
  group("cas", { kind: "cea", acronym: "CAS", intranetType: "CAS" }),
  // The roll call goes in reverse alphabetical order: C, B, A.
  group("ca", { kind: "asociado", intranetType: "Asociado", name: "A" }),
  group("cb", { kind: "asociado", intranetType: "Asociado", name: "B" }),
  group("cc", { kind: "asociado", intranetType: "Asociado", name: "C" }),
  group("sec", { kind: "sectorial", intranetType: "Sectorial", name: "S" }),
  group("guest", { kind: "other", intranetType: "Invitado", name: "G" }),
];

// The CAS's own place is checked on its own ("seats the CAS right after the
// sectoriales"), in a room with a seat more for it.
const people: SeatingPersonInput[] = [
  ...peopleOf("mesa", 2),
  ...peopleOf("se", 1),
  ...peopleOf("pres", 1),
  ...peopleOf("tes", 1),
  ...peopleOf("cc", 3),
  ...peopleOf("cb", 2),
  ...peopleOf("ca", 2),
  ...peopleOf("sec", 2),
  ...peopleOf("guest", 1),
  // Never placed.
  {
    id: "guest-x",
    groupId: "guest",
    needsSeat: false,
    goneAt: null,
    position: 5,
  },
  {
    id: "guest-y",
    groupId: "guest",
    needsSeat: true,
    goneAt: "2026-11-15T10:00:00Z",
    position: 6,
  },
];

const input = (
  over: Partial<SeatingProposalInput> = {},
): SeatingProposalInput => ({
  layout,
  groups,
  people,
  assignments: [],
  assemblyType: "AGO",
  mode: "redoAll",
  ...over,
});

const seating = (assignments: readonly SeatAssignment[]) =>
  Object.fromEntries(
    assignments.map((entry) => [entry.personId, entry.seatId]),
  );

describe("proposeSeating", () => {
  it("seats the Mesa, the CEA and the roll call, each in its place", () => {
    const proposal = proposeSeating(input());
    expect(seating(proposal.assignments)).toEqual({
      // The Mesa's group and the SE, centred at the Mesa's table.
      "mesa-1": "m1",
      "mesa-2": "m2",
      "se-1": "m3",
      // The CEA in the Intranet's order.
      "pres-1": "B0",
      "tes-1": "B1",
      // C fills the left arm; B does not fit what is left there and goes to
      // the right arm; A goes on to the inner row, then the sectorial.
      "cc-1": "L0",
      "cc-2": "L1",
      "cc-3": "L2",
      "cb-1": "R0",
      "cb-2": "R1",
      "ca-1": "V0",
      "ca-2": "V1",
      "sec-1": "V2",
      "sec-2": "V3",
      // The guest fits nowhere further on and takes what was left behind.
      "guest-1": "R2",
    });
    expect(proposal.splits).toEqual([]);
    expect(proposal.unseated).toEqual([]);
    expect(proposal.placed).toEqual(proposal.assignments);
  });

  it("seats PRES and SE at the Mesa at an AGE", () => {
    const proposal = proposeSeating(input({ assemblyType: "AGE" }));
    const seats = seating(proposal.assignments);
    expect([
      seats["mesa-1"],
      seats["mesa-2"],
      seats["pres-1"],
      seats["se-1"],
    ]).toEqual(["m0", "m1", "m2", "m3"]);
    expect(seats["tes-1"]).toBe("B0");
  });

  it("seats the CAS right after the sectoriales, never on the CEA's base", () => {
    const roomier: SeatingLayout = {
      ...layout,
      tables: layout.tables.map((t) =>
        t.id === "v"
          ? {
              ...t,
              seats: [...t.seats, { id: "V4", side: "front", index: 4 }],
            }
          : t,
      ),
    };
    const proposal = proposeSeating(
      input({ layout: roomier, people: [...people, ...peopleOf("cas", 1)] }),
    );
    const seats = seating(proposal.assignments);
    // The base keeps free seats (B2 to B5), and the CAS still goes on
    // after the sectorial, before the guest.
    expect([seats["sec-1"], seats["sec-2"], seats["cas-1"]]).toEqual([
      "V2",
      "V3",
      "V4",
    ]);
    expect(seats["guest-1"]).toBe("R2");
    expect(proposal.unseated).toEqual([]);
  });

  it("sends an office the Mesa has no seat for to the CEA", () => {
    const proposal = proposeSeating(
      input({
        people: [
          ...people.filter((person) => person.groupId !== "mesa"),
          ...peopleOf("mesa", 5),
        ],
      }),
    );
    const seats = seating(proposal.assignments);
    expect(seats["se-1"]).toBe("B1");
    expect(seats["pres-1"]).toBe("B0");
  });

  it("lists the Mesa people left without a seat at its table", () => {
    const proposal = proposeSeating(
      input({
        people: [
          ...people.filter((person) => person.groupId !== "mesa"),
          ...peopleOf("mesa", 6),
        ],
      }),
    );
    expect(proposal.unseated).toEqual([
      { groupId: "mesa", personIds: ["mesa-6"] },
    ]);
  });

  it("never splits a delegation over the CEA's base", () => {
    // Four from C fit neither arm: they go whole to the inner row.
    const proposal = proposeSeating(
      input({
        people: [
          ...people.filter((person) => person.groupId !== "cc"),
          ...peopleOf("cc", 4),
        ],
      }),
    );
    const seats = seating(proposal.assignments);
    expect(["cc-1", "cc-2", "cc-3", "cc-4"].map((id) => seats[id])).toEqual([
      "V0",
      "V1",
      "V2",
      "V3",
    ]);
  });

  it("splits only when nothing holds a group whole, the largest first, and lists it", () => {
    const proposal = proposeSeating(
      input({
        people: [
          ...people.filter((person) => person.groupId !== "cc"),
          ...peopleOf("cc", 4),
        ],
      }),
    );
    const seats = seating(proposal.assignments);
    // B and A (2 each) take whole stretches; the sectorial is split over
    // the single seats left; the guest finds none.
    expect([seats["cb-1"], seats["cb-2"]]).toEqual(["L0", "L1"]);
    expect([seats["ca-1"], seats["ca-2"]]).toEqual(["R0", "R1"]);
    expect([seats["sec-1"], seats["sec-2"]]).toEqual(["L2", "R2"]);
    expect(proposal.splits).toEqual([{ groupId: "sec", pieces: [1, 1] }]);
    expect(proposal.unseated).toEqual([
      { groupId: "guest", personIds: ["guest-1"] },
    ]);
  });

  it("never fills free tables or loose chairs", () => {
    const proposal = proposeSeating(input());
    const taken = new Set(proposal.assignments.map((entry) => entry.seatId));
    for (const seatId of ["F0", "F1", "c0"]) {
      expect(taken.has(seatId)).toBe(false);
    }
  });

  it("keeps everyone seated when it fills empty seats", () => {
    const current = [
      { seatId: "m0", personId: "mesa-1" },
      { seatId: "F0", personId: "guest-1" },
      { seatId: "R0", personId: "cc-1" },
      { seatId: "R1", personId: "cc-2" },
    ];
    const proposal = proposeSeating(
      input({ mode: "fillEmpty", assignments: current }),
    );
    const seats = seating(proposal.assignments);
    expect(seats["mesa-1"]).toBe("m0");
    expect(seats["guest-1"]).toBe("F0");
    // C's third person sits next to the other two.
    expect(seats["cc-3"]).toBe("R2");
    // The rest of the Mesa, centred on the free seats left there.
    expect([seats["mesa-2"], seats["se-1"]]).toEqual(["m2", "m3"]);
    expect(proposal.placed).not.toContainEqual({
      seatId: "m0",
      personId: "mesa-1",
    });
    expect(proposal.placed).toContainEqual({ seatId: "R2", personId: "cc-3" });
  });

  it("lists a group it could not seat next to its people as split", () => {
    const current = [
      { seatId: "R0", personId: "cc-1" },
      { seatId: "R1", personId: "cc-2" },
      { seatId: "R2", personId: "guest-1" },
    ];
    const proposal = proposeSeating(
      input({ mode: "fillEmpty", assignments: current }),
    );
    expect(proposal.splits).toContainEqual({ groupId: "cc", pieces: [1, 2] });
  });

  it("starts over when it redoes everything", () => {
    const proposal = proposeSeating(
      input({
        mode: "redoAll",
        assignments: [{ seatId: "F0", personId: "guest-1" }],
      }),
    );
    expect(seating(proposal.assignments)["guest-1"]).toBe("R2");
  });

  it("drops seats that are gone or disabled and people unknown", () => {
    const disabled: SeatingLayout = {
      ...layout,
      tables: layout.tables.map((t) =>
        t.id === "l"
          ? {
              ...t,
              seats: t.seats.map((s) => ({ ...s, disabled: s.id === "L1" })),
            }
          : t,
      ),
    };
    const proposal = proposeSeating(
      input({
        layout: disabled,
        mode: "fillEmpty",
        assignments: [
          { seatId: "L1", personId: "cc-1" },
          { seatId: "X9", personId: "cc-2" },
          { seatId: "L0", personId: "ghost" },
        ],
      }),
    );
    const taken = proposal.assignments.map((entry) => entry.seatId);
    expect(taken).not.toContain("L1");
    expect(taken).not.toContain("X9");
    expect(proposal.assignments.map((entry) => entry.personId)).not.toContain(
      "ghost",
    );
  });

  it("is deterministic whatever the order of its input", () => {
    const first = proposeSeating(input());
    const shuffled = proposeSeating(
      input({ groups: [...groups].reverse(), people: [...people].reverse() }),
    );
    expect(shuffled).toEqual(first);
  });
});

describe("proposeSeating in the default Doble U", () => {
  // Invented: 22 offices, the CAS, 26 councils of 1 to 4 and 10 sectorials.
  const room = defaultDoubleULayout();
  const walk = seatingWalk(room);
  const offices = Array.from({ length: 22 }, (_, index) =>
    group(`off${index}`, {
      kind: "cea",
      intranetType: "CEA",
      acronym: index === 1 ? "SE" : `O${index}`,
      order: index + 1,
    }),
  );
  const councils = Array.from({ length: 26 }, (_, index) =>
    group(`cou${index}`, {
      kind: "asociado",
      intranetType: "Asociado",
      name: `Consejo ${String(index).padStart(2, "0")}`,
    }),
  );
  const sectorials = Array.from({ length: 10 }, (_, index) =>
    group(`sec${index}`, {
      kind: "sectorial",
      intranetType: "Sectorial",
      name: `Sectorial ${index}`,
    }),
  );
  const all = [
    group("mesa", { kind: "mesa" }),
    ...offices,
    group("cas", { kind: "cea", acronym: "CAS", intranetType: "CAS" }),
    ...councils,
    ...sectorials,
  ];
  const everyone = [
    ...peopleOf("mesa", 2),
    ...offices.flatMap((office) => peopleOf(office.id, 1)),
    ...peopleOf("cas", 1),
    ...councils.flatMap((council, index) =>
      peopleOf(council.id, (index % 4) + 1),
    ),
    ...sectorials.flatMap((sectorial) => peopleOf(sectorial.id, 1)),
  ];
  const proposal = proposeSeating({
    layout: room,
    groups: all,
    people: everyone,
    assignments: [],
    assemblyType: "AGO",
    mode: "redoAll",
  });
  const zoneOf = (personId: string) =>
    walk.seats.get(
      proposal.assignments.find((entry) => entry.personId === personId)!.seatId,
    )!;

  it("seats everyone, every delegation together", () => {
    expect(everyone).toHaveLength(98);
    expect(proposal.unseated).toEqual([]);
    expect(proposal.splits).toEqual([]);
    expect(proposal.assignments).toHaveLength(everyone.length);
  });

  it("puts the Mesa and the SE at the Mesa's table", () => {
    for (const id of ["mesa-1", "mesa-2", "off1-1"]) {
      expect(zoneOf(id).zone).toBe("presiding");
    }
  });

  it("puts the CEA on the base and the rest beside it", () => {
    const cea = offices
      .filter((office) => office.acronym !== "SE")
      .map((office) => zoneOf(`${office.id}-1`));
    // 18 seats on the base, in the Intranet's order, then up the arm after it.
    expect(cea.slice(0, 18).every((seat) => seat.zone === "cea")).toBe(true);
    for (let index = 1; index < 18; index += 1) {
      expect(cea[index]!.position).toBe(cea[index - 1]!.position + 1);
    }
    const beyond = cea.slice(18);
    expect(beyond.map((seat) => seat.position)).toEqual([
      cea[17]!.position + 1,
      cea[17]!.position + 2,
      cea[17]!.position + 3,
    ]);
    expect(beyond.every((seat) => seat.zone === "delegates")).toBe(true);
  });

  it("puts the CAS with the sectoriales, never on the CEA's base", () => {
    const cas = zoneOf("cas-1");
    expect(cas.zone).toBe("delegates");
    // Right after the last sectorial of the roll call (reverse alphabetical:
    // «Sectorial 0»), along the same run.
    const last = zoneOf("sec0-1");
    expect(cas.run).toBe(last.run);
    expect(cas.position).toBe(last.position + 1);
  });
});

describe("assignmentOps", () => {
  it("turns one room into another, one op per seat that changes", () => {
    expect(
      assignmentOps(
        [
          { seatId: "s1", personId: "a" },
          { seatId: "s2", personId: "b" },
          { seatId: "s3", personId: "c" },
        ],
        [
          { seatId: "s1", personId: "a" },
          { seatId: "s2", personId: "c" },
          { seatId: "s4", personId: "b" },
        ],
      ),
    ).toEqual([
      { seatId: "s2", expected: "b", next: "c" },
      { seatId: "s3", expected: "c", next: null },
      { seatId: "s4", expected: null, next: "b" },
    ]);
  });
});

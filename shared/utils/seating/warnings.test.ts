import { describe, expect, it } from "vitest";
import type { SeatingGroupInput, SeatingPersonInput } from "./groups";
import { emptySeatingLayout, type SeatingLayout } from "./layout";
import { seatingWarnings } from "./warnings";

const layout = (seatIds: string[]): SeatingLayout => ({
  ...emptySeatingLayout(),
  tables: [
    {
      id: "t",
      shape: "rect",
      x: 0,
      y: 0,
      w: 600,
      h: 60,
      rotation: 0,
      zone: "delegates",
      run: "row",
      seats: seatIds.map((id, index) => ({ id, side: "front", index })),
    },
  ],
});

const group = (
  id: string,
  over: Partial<SeatingGroupInput> = {},
): SeatingGroupInput => ({
  id,
  kind: "asociado",
  intranetType: "Asociado",
  acronym: id.toUpperCase(),
  name: id,
  order: null,
  goneAt: null,
  ...over,
});

const person = (
  id: string,
  groupId: string,
  over: Partial<SeatingPersonInput> = {},
): SeatingPersonInput => ({
  id,
  groupId,
  needsSeat: true,
  goneAt: null,
  position: 0,
  ...over,
});

describe("seatingWarnings", () => {
  const room = layout(["s1", "s2", "s3", "s4", "s5"]);
  const groups = [
    group("a", { name: "Z" }),
    group("b", { name: "Y" }),
    group("c", { name: "X" }),
  ];

  it("warns of groups not seated, seated in part, split, and of people gone", () => {
    const people = [
      person("a1", "a"),
      person("a2", "a"),
      person("a3", "a", { goneAt: "2026-11-15T10:00:00Z" }),
      person("b1", "b"),
      person("b2", "b"),
      person("c1", "c"),
    ];
    const warnings = seatingWarnings({
      layout: room,
      groups,
      people,
      assignments: [
        { seatId: "s1", personId: "a1" },
        { seatId: "s3", personId: "a2" },
        { seatId: "s5", personId: "a3" },
        { seatId: "s2", personId: "b1" },
      ],
    });
    expect(warnings).toEqual([
      { kind: "group_unseated", groupId: "c", total: 1 },
      { kind: "group_partly_seated", groupId: "b", seated: 1, total: 2 },
      { kind: "group_split", groupId: "a", pieces: [1, 1, 1] },
      { kind: "gone_seated", groupId: "a", personId: "a3", seatId: "s5" },
    ]);
  });

  it("warns of seats short and spare", () => {
    const people = Array.from({ length: 6 }, (_, index) =>
      person(`p${index}`, "a", { position: index }),
    );
    expect(
      seatingWarnings({ layout: room, groups, people, assignments: [] })[0],
    ).toEqual({ kind: "seats_short", seats: 5, people: 6 });
    expect(
      seatingWarnings({
        layout: room,
        groups,
        people: [person("p", "a"), person("q", "a", { needsSeat: false })],
        assignments: [{ seatId: "s1", personId: "p" }],
      }),
    ).toEqual([{ kind: "seats_spare", seats: 5, people: 1 }]);
  });

  it("warns of seats an edit takes from people", () => {
    const draft = layout(["s1", "s2"]);
    const warnings = seatingWarnings({
      layout: draft,
      savedLayout: room,
      groups,
      people: [person("a1", "a"), person("b1", "b")],
      assignments: [
        { seatId: "s1", personId: "a1" },
        { seatId: "s4", personId: "b1" },
      ],
    });
    expect(warnings[0]).toEqual({
      kind: "seats_lost",
      seatIds: ["s4"],
      personIds: ["b1"],
    });
  });

  it("says nothing of a room in order", () => {
    expect(
      seatingWarnings({
        layout: layout(["s1", "s2"]),
        groups,
        people: [person("a1", "a"), person("a2", "a", { position: 1 })],
        assignments: [
          { seatId: "s1", personId: "a1" },
          { seatId: "s2", personId: "a2" },
        ],
      }),
    ).toEqual([]);
  });
});

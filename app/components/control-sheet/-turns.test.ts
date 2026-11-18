import { describe, expect, it } from "vitest";
import type { AgendaItemDto, SpeakingTurnDto } from "~~/shared/types/api";
import {
  NO_ITEM,
  buildTurnRows,
  filterTurnRows,
  totalTurnSeconds,
  turnItemOptions,
  turnItems,
  turnTotals,
  turnWhoKey,
  turnWhoOptions,
} from "./-turns";

const UGR = {
  id: "m-ugr",
  acronym: "CEUGR",
  name: "Consejo de Estudiantes",
  kind: "asociado" as const,
};
const ANEM = {
  id: "m-anem",
  acronym: "ANEM",
  name: "Asociación Nacional",
  kind: "sectorial" as const,
};

function turn(
  id: string,
  overrides: Partial<SpeakingTurnDto> = {},
): SpeakingTurnDto {
  return {
    id,
    member: null,
    speaker: null,
    agendaItemId: null,
    status: "done",
    position: 0,
    startedAt: null,
    endedAt: null,
    createdAt: "2026-11-21T09:00:00.000Z",
    updatedAt: "2026-11-21T09:00:00.000Z",
    ...overrides,
  };
}

function item(
  id: string,
  order: number,
  parentId: string | null = null,
): AgendaItemDto {
  return {
    id,
    parentId,
    order,
    title: `Punto ${id}`,
    titleHidden: false,
  } as AgendaItemDto;
}

const AGENDA = turnItems([item("a", 1), item("b", 2), item("b1", 1, "b")]);

const TURNS = [
  turn("t1", {
    member: UGR,
    agendaItemId: "b1",
    startedAt: "2026-11-21T10:00:00.000Z",
    endedAt: "2026-11-21T10:02:30.000Z",
  }),
  turn("t2", {
    member: ANEM,
    speaker: "Ana Pérez",
    agendaItemId: "a",
    startedAt: "2026-11-21T10:03:00.000Z",
    endedAt: "2026-11-21T10:04:00.000Z",
  }),
  turn("t3", {
    speaker: "  Luis ",
    startedAt: "2026-11-21T10:05:00.000Z",
    endedAt: "2026-11-21T10:05:20.000Z",
  }),
  turn("t4", {
    member: UGR,
    agendaItemId: "b1",
    status: "speaking",
    startedAt: "2026-11-21T10:06:00.000Z",
  }),
];

const NOW = new Date("2026-11-21T10:07:00.000Z").getTime();

describe("turnWhoKey", () => {
  it("keys by member, else by the name written down, else nobody", () => {
    expect(turnWhoKey({ member: UGR, speaker: "Ana" })).toBe("member:m-ugr");
    expect(turnWhoKey({ member: null, speaker: " Luis " })).toBe(
      turnWhoKey({ member: null, speaker: "luis" }),
    );
    expect(turnWhoKey({ member: null, speaker: "  " })).toBe("unnamed");
  });
});

describe("buildTurnRows", () => {
  const rows = buildTurnRows(TURNS, AGENDA);

  it("numbers the turns in order and names their numbered item", () => {
    expect(rows.map((row) => row.index)).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.item).toMatchObject({ id: "b1", number: "2.1" });
    expect(rows[1]!.item).toMatchObject({ id: "a", number: "1" });
    expect(rows[2]!.item).toBeNull();
  });

  it("measures finished turns and leaves the one with the floor open", () => {
    expect(rows.map((row) => row.seconds)).toEqual([150, 60, 20, null]);
    expect(rows[3]!.speaking).toBe(true);
  });

  it("leaves out turns that never took the floor", () => {
    const waiting = turn("w", { status: "waiting" });
    expect(buildTurnRows([...TURNS, waiting], AGENDA)).toHaveLength(4);
  });
});

describe("filters and totals", () => {
  const rows = buildTurnRows(TURNS, AGENDA);

  it("filters by item, by no item and by who", () => {
    expect(
      filterTurnRows(rows, { itemId: "b1", whoKey: null }).map(
        (row) => row.turn.id,
      ),
    ).toEqual(["t1", "t4"]);
    expect(
      filterTurnRows(rows, { itemId: NO_ITEM, whoKey: null }).map(
        (row) => row.turn.id,
      ),
    ).toEqual(["t3"]);
    expect(
      filterTurnRows(rows, { itemId: null, whoKey: "member:m-anem" }).map(
        (row) => row.turn.id,
      ),
    ).toEqual(["t2"]);
  });

  it("counts the turn with the floor up to now", () => {
    expect(totalTurnSeconds(rows, NOW)).toBe(150 + 60 + 20 + 60);
  });

  it("adds up per member, longest first", () => {
    const totals = turnTotals(rows, NOW);
    expect(
      totals.map((total) => [total.whoKey, total.turns, total.seconds]),
    ).toEqual([
      ["member:m-ugr", 2, 210],
      ["member:m-anem", 1, 60],
      ["speaker:luis", 1, 20],
    ]);
    expect(totals[0]!.speaking).toBe(true);
    expect(totals[1]!.speaker).toBeNull();
    expect(totals[2]!.speaker).toBe("Luis");
  });

  it("offers the items with turns in the agenda's order, and who once", () => {
    const options = turnItemOptions(rows, AGENDA);
    expect(options.items.map((entry) => entry.id)).toEqual(["a", "b1"]);
    expect(options.none).toBe(true);
    expect(turnWhoOptions(rows).map((entry) => entry.whoKey)).toEqual([
      "member:m-ugr",
      "member:m-anem",
      "speaker:luis",
    ]);
  });
});

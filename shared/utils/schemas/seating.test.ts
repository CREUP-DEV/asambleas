import { describe, expect, it } from "vitest";
import { defaultDoubleULayout } from "../seating/templates";
import type { SeatingLayout } from "../seating/layout";
import {
  SEATING_LIMITS,
  intranetAttendeesResponseSchema,
  seatingAssignmentsBodySchema,
  seatingGroupCreateBodySchema,
  seatingGroupUpdateBodySchema,
  seatingLayoutBodySchema,
  seatingLayoutSchema,
  seatingPersonCreateBodySchema,
  seatingPersonUpdateBodySchema,
  seatingSourceBodySchema,
} from "./seating";

/** Ids that pass the entity id pattern. */
const id = (n: number, prefix = "s") =>
  `${prefix}${String(n).padStart(23, "0")}`;
function counter(prefix: string) {
  let next = 0;
  return () => id(++next, prefix);
}
const at = "2026-11-15T10:00:00.000Z";

const layout = (): SeatingLayout =>
  defaultDoubleULayout({ createId: counter("a") });

describe("seatingLayoutSchema", () => {
  it("parses the default Doble U as it is", () => {
    const room = layout();
    expect(seatingLayoutSchema.parse(room)).toEqual(room);
    // And with real cuid2 ids.
    const real = defaultDoubleULayout();
    expect(seatingLayoutSchema.parse(real)).toEqual(real);
  });

  it("refuses more than 600 seats, tables and chairs together", () => {
    const room = layout();
    const seats = room.tables.reduce((sum, t) => sum + t.seats.length, 0);
    room.chairs = Array.from(
      { length: SEATING_LIMITS.seats - seats + 1 },
      (_, index) => ({ id: id(index, "c"), x: 0, y: 0, rotation: 0 }),
    );
    expect(seatingLayoutSchema.safeParse(room).success).toBe(false);
    room.chairs.pop();
    expect(seatingLayoutSchema.safeParse(room).success).toBe(true);
  });

  it("refuses more than 200 tables and 60 landmarks", () => {
    const room = layout();
    const extra = room.tables[1]!;
    room.tables = Array.from(
      { length: SEATING_LIMITS.tables + 1 },
      (_, index) => ({
        ...extra,
        id: id(index, "t"),
        slot: undefined,
        seats: [],
      }),
    ).map(({ slot: _slot, ...table }) => table);
    expect(seatingLayoutSchema.safeParse(room).success).toBe(false);

    const fixtures = layout();
    fixtures.fixtures = Array.from(
      { length: SEATING_LIMITS.fixtures + 1 },
      (_, index) => ({
        id: id(index, "f"),
        kind: "label" as const,
        x: 0,
        y: 0,
        w: 100,
        h: 20,
        rotation: 0,
      }),
    );
    expect(seatingLayoutSchema.safeParse(fixtures).success).toBe(false);
  });

  it("keeps everything within ±100 m and labels within 60 characters", () => {
    const far = layout();
    far.tables[0]!.x = 10_001;
    expect(seatingLayoutSchema.safeParse(far).success).toBe(false);
    const named = layout();
    named.tables[0]!.seats[0]!.label = "x".repeat(61);
    expect(seatingLayoutSchema.safeParse(named).success).toBe(false);
    named.tables[0]!.seats[0]!.label = "  Presidencia   de la Mesa ";
    expect(seatingLayoutSchema.parse(named).tables[0]!.seats[0]!.label).toBe(
      "Presidencia de la Mesa",
    );
  });

  it("refuses repeated ids and seats in one place", () => {
    const seat = layout();
    seat.chairs = [
      { id: seat.tables[0]!.seats[0]!.id, x: 0, y: 0, rotation: 0 },
    ];
    expect(seatingLayoutSchema.safeParse(seat).success).toBe(false);
    const place = layout();
    place.tables[0]!.seats[1]!.index = 0;
    expect(seatingLayoutSchema.safeParse(place).success).toBe(false);
    const tableId = layout();
    tableId.tables[1]!.id = tableId.tables[0]!.id;
    expect(seatingLayoutSchema.safeParse(tableId).success).toBe(false);
  });

  it("refuses rotations off the 15° steps, odd sides and the chairs' run", () => {
    const turned = layout();
    turned.tables[0]!.rotation = 10;
    expect(seatingLayoutSchema.safeParse(turned).success).toBe(false);
    const around = layout();
    around.tables[0]!.seats[0]!.side = "around";
    expect(seatingLayoutSchema.safeParse(around).success).toBe(false);
    const loose = layout();
    loose.tables[0]!.run = "loose";
    expect(seatingLayoutSchema.safeParse(loose).success).toBe(false);
  });

  it("checks the Doble U's numbers and accepts later templates", () => {
    const room = layout();
    room.template = {
      kind: "double_u",
      params: { ...(room.template.params as object), innerBaseTables: 5 },
    } as SeatingLayout["template"];
    expect(seatingLayoutSchema.safeParse(room).success).toBe(false);
    const rows = layout();
    rows.template = { kind: "rows", params: { rows: 6, seatsPerRow: 12 } };
    expect(seatingLayoutSchema.safeParse(rows).success).toBe(true);
    const unknown = layout();
    (unknown.template as { kind: string }).kind = "circle";
    expect(seatingLayoutSchema.safeParse(unknown).success).toBe(false);
  });

  it("refuses another schema version", () => {
    const room = { ...layout(), schemaVersion: 2 };
    expect(seatingLayoutSchema.safeParse(room).success).toBe(false);
  });
});

describe("bodies", () => {
  it("takes a layout with its token, null before the first save", () => {
    expect(
      seatingLayoutBodySchema.parse({ layout: layout(), updatedAt: null })
        .updatedAt,
    ).toBeNull();
    // The seats and people a 409 named, confirmed one by one.
    expect(
      seatingLayoutBodySchema.safeParse({
        layout: layout(),
        updatedAt: at,
        releaseSeats: [{ seatId: id(1, "s"), personId: id(1, "p") }],
      }).success,
    ).toBe(true);
    // Never a blanket «yes» that would cover whoever sits there later.
    expect(
      seatingLayoutBodySchema.safeParse({
        layout: layout(),
        updatedAt: at,
        releaseSeats: true,
      }).success,
    ).toBe(false);
  });

  it("takes up to 600 seat changes, each seat and person once", () => {
    const op = (seat: number, next: number | null) => ({
      seatId: id(seat),
      expected: null,
      next: next === null ? null : id(next, "p"),
    });
    expect(
      seatingAssignmentsBodySchema.safeParse({ ops: [op(1, 1), op(2, null)] })
        .success,
    ).toBe(true);
    expect(seatingAssignmentsBodySchema.safeParse({ ops: [] }).success).toBe(
      false,
    );
    expect(
      seatingAssignmentsBodySchema.safeParse({ ops: [op(1, 1), op(1, 2)] })
        .success,
    ).toBe(false);
    expect(
      seatingAssignmentsBodySchema.safeParse({ ops: [op(1, 1), op(2, 1)] })
        .success,
    ).toBe(false);
    expect(
      seatingAssignmentsBodySchema.safeParse({
        ops: Array.from({ length: 601 }, (_, index) => op(index, null)),
      }).success,
    ).toBe(false);
  });

  it("takes groups made by hand, never the Mesa", () => {
    expect(
      seatingGroupCreateBodySchema.parse({
        acronym: " Prensa ",
        name: "Prensa",
      }),
    ).toEqual({ acronym: "Prensa", name: "Prensa" });
    expect(
      seatingGroupCreateBodySchema.safeParse({
        acronym: "M",
        name: "Mesa",
        kind: "mesa",
      }).success,
    ).toBe(false);
    expect(
      seatingGroupCreateBodySchema.safeParse({
        acronym: "x".repeat(21),
        name: "X",
      }).success,
    ).toBe(false);
    expect(
      seatingGroupUpdateBodySchema.safeParse({ updatedAt: at }).success,
    ).toBe(false);
    expect(
      seatingGroupUpdateBodySchema.safeParse({ updatedAt: at, name: "Medios" })
        .success,
    ).toBe(true);
  });

  it("takes people by hand with a name and placeholders without", () => {
    expect(
      seatingPersonCreateBodySchema.safeParse({
        source: "manual",
        groupId: id(1, "g"),
        firstName: "Lucía",
        surname: "Ejemplo Inventado",
        label: "Vocalía de la Mesa",
      }).success,
    ).toBe(true);
    expect(
      seatingPersonCreateBodySchema.safeParse({
        source: "manual",
        groupId: id(1, "g"),
      }).success,
    ).toBe(false);
    expect(
      seatingPersonCreateBodySchema.safeParse({
        source: "placeholder",
        groupId: id(1, "g"),
        firstName: "Nadie",
      }).success,
    ).toBe(false);
    expect(
      seatingPersonCreateBodySchema.safeParse({
        source: "intranet",
        groupId: id(1, "g"),
      }).success,
    ).toBe(false);
    expect(
      seatingPersonUpdateBodySchema.safeParse({
        updatedAt: at,
        needsSeat: false,
        position: 3,
      }).success,
    ).toBe(true);
    expect(
      seatingPersonUpdateBodySchema.safeParse({ updatedAt: at }).success,
    ).toBe(false);
  });

  it("drops control characters from names, which Postgres would refuse", () => {
    const parsed = seatingPersonCreateBodySchema.parse({
      source: "manual",
      groupId: id(1, "g"),
      firstName: "Lu\u0000cía\u0007",
      surname: "Ejemplo\u001F Inventado",
    });
    expect(parsed).toMatchObject({
      firstName: "Lucía",
      surname: "Ejemplo Inventado",
    });
    expect(
      seatingPersonCreateBodySchema.safeParse({
        source: "manual",
        groupId: id(1, "g"),
        firstName: "\u0000\u0000",
      }).success,
    ).toBe(false);
  });

  it("takes the source with the one the client read", () => {
    expect(
      seatingSourceBodySchema.safeParse({
        sourceAssemblyId: id(1, "x"),
        expected: null,
      }).success,
    ).toBe(true);
    expect(
      seatingSourceBodySchema.safeParse({ sourceAssemblyId: id(1, "x") })
        .success,
    ).toBe(false);
  });
});

describe("intranetAttendeesResponseSchema", () => {
  const answer = () => ({
    event: {
      id: 98,
      name: "80.ª Asamblea General Ordinaria",
      start_date: "2026-11-18",
      end_date: "2026-11-22",
    },
    accounts: [
      {
        id: 412,
        type: "Asociado",
        category: "Multiusuario",
        initials: "CdEX",
        designation: "Consejo de Ejemplo",
        university_acronym: "UX",
        order: null,
        logo_version: "3F2A9b",
        extra: "ignored",
      },
      {
        id: 7,
        type: "CEA",
        category: "Individual",
        initials: "SE",
        designation: "Secretaría Ejecutiva",
        university_acronym: null,
        order: 2,
        logo_version: null,
      },
    ],
    attendees: [
      {
        id: 5120,
        account_id: 412,
        name: "Ana",
        surname: "Inventada  Pérez",
        status: "Confirmada",
        modality: "Regular · con alojamiento",
        photo_version: null,
      },
      {
        id: 5121,
        account_id: 7,
        name: "Luis",
        surname: "Ficticio",
        status: "Pendiente",
        modality: null,
        photo_version: "../../etc",
      },
    ],
    generated_at: "2026-11-15T10:15:00+01:00",
  });

  it("reads the contract, unknown keys and the modality dropped", () => {
    const parsed = intranetAttendeesResponseSchema.parse(answer());
    expect(parsed.accounts[0]).toEqual({
      id: 412,
      type: "Asociado",
      category: "Multiusuario",
      initials: "CdEX",
      designation: "Consejo de Ejemplo",
      university_acronym: "UX",
      order: null,
      logo_version: "3f2a9b",
    });
    expect(parsed.attendees[0]).toEqual({
      id: 5120,
      account_id: 412,
      name: "Ana",
      surname: "Inventada Pérez",
      status: "Confirmada",
      photo_version: null,
    });
    // A version that could not name a file is no image.
    expect(parsed.attendees[1]!.photo_version).toBeNull();
  });

  it("drops control characters from the names it brings", () => {
    const value = answer();
    value.attendees[0]!.name = "A\u0000na";
    value.attendees[0]!.surname = "\u0000";
    const parsed = intranetAttendeesResponseSchema.parse(value);
    expect(parsed.attendees[0]).toMatchObject({ name: "Ana", surname: null });
  });

  it("keeps the first row of an id listed twice", () => {
    const body = answer();
    body.attendees.push({ ...body.attendees[0]!, name: "Otra" });
    const parsed = intranetAttendeesResponseSchema.parse(body);
    expect(parsed.attendees).toHaveLength(2);
    expect(parsed.attendees[0]!.name).toBe("Ana");
  });

  it("refuses the whole answer for an attendee of an unknown account", () => {
    const body = answer();
    body.attendees[0]!.account_id = 999;
    expect(intranetAttendeesResponseSchema.safeParse(body).success).toBe(false);
  });

  it("refuses the whole answer for a status other than Pendiente or Confirmada", () => {
    const body = answer();
    body.attendees[0]!.status = "Rechazada";
    expect(intranetAttendeesResponseSchema.safeParse(body).success).toBe(false);
  });

  it("refuses the whole answer for a bad id or too many rows", () => {
    const body = answer();
    (body.attendees[0] as { id: unknown }).id = "5120";
    expect(intranetAttendeesResponseSchema.safeParse(body).success).toBe(false);
    const long = answer();
    long.attendees = Array.from({ length: 5001 }, (_, index) => ({
      ...long.attendees[0]!,
      id: index + 1,
    }));
    expect(intranetAttendeesResponseSchema.safeParse(long).success).toBe(false);
  });
});

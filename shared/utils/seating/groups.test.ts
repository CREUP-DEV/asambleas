import { describe, expect, it } from "vitest";
import {
  CAS_SITS_WITH,
  MESA_OFFICE_ACRONYMS,
  groupSeatCounts,
  isMesaOffice,
  orderSeatingGroups,
  seatingCategoryForIntranet,
  seatingCounts,
  seatingGroupColour,
  seatingKindForIntranetType,
  seatingLegend,
  seatingLegendKind,
  seatingPlacementKind,
  seatingStatusForIntranet,
  type SeatingGroupInput,
  type SeatingPersonInput,
} from "./groups";

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
  status: "confirmed",
  ...over,
});

describe("from the Intranet", () => {
  it("maps account types to kinds, the CAS a CEA account as in the Intranet", () => {
    expect(seatingKindForIntranetType("Asociado")).toBe("asociado");
    expect(seatingKindForIntranetType("Sectorial")).toBe("sectorial");
    expect(seatingKindForIntranetType("CEA")).toBe("cea");
    expect(seatingKindForIntranetType("CAS")).toBe("cea");
    // ...but it sits with the sectoriales (user, 2026-11-15).
    expect(CAS_SITS_WITH).toBe("sectorial");
    expect(
      seatingPlacementKind(group("g", { kind: "cea", intranetType: "CAS" })),
    ).toBe("sectorial");
    expect(
      seatingPlacementKind(group("g", { kind: "cea", intranetType: "CEA" })),
    ).toBe("cea");
    for (const type of [
      "CAI",
      "CdG",
      "Invitado",
      "Otros",
      "Desasociado",
      "",
      null,
    ]) {
      expect(seatingKindForIntranetType(type)).toBe("other");
    }
  });

  it("maps categories and statuses", () => {
    expect(seatingCategoryForIntranet("Individual")).toBe("individual");
    expect(seatingCategoryForIntranet("Multiusuario")).toBe("multiuser");
    expect(seatingCategoryForIntranet("Otra")).toBeNull();
    expect(seatingStatusForIntranet("Confirmada")).toBe("confirmed");
    expect(seatingStatusForIntranet("Pendiente")).toBe("pending");
  });
});

describe("colours", () => {
  it("follows the kind and the Intranet type together", () => {
    const colour = (over: Partial<SeatingGroupInput>) =>
      seatingGroupColour(group("g", over));
    expect(colour({ kind: "mesa" })).toBe("primary");
    expect(colour({ kind: "cea", intranetType: "CEA" })).toBe("primary");
    // The CdG beige (user, 2026-11-15).
    expect(colour({ kind: "other", intranetType: "CdG" })).toBe("beige");
    expect(colour({ kind: "sectorial", intranetType: "Sectorial" })).toBe(
      "sectorial",
    );
    // The CAS is a CEA account, and green.
    expect(colour({ kind: "cea", intranetType: "CAS" })).toBe("sectorial");
    expect(colour({ kind: "asociado", intranetType: "Asociado" })).toBe("info");
    expect(colour({ kind: "other", intranetType: "CAI" })).toBe("info");
    // Guests and every other account, beige like the CdG (user, 2026-11-15).
    expect(colour({ kind: "other", intranetType: "Invitado" })).toBe("beige");
    expect(colour({ kind: "other", intranetType: "Otros" })).toBe("beige");
    expect(colour({ kind: "other", intranetType: null })).toBe("beige");
    // A group made by hand for a council.
    expect(colour({ kind: "asociado" })).toBe("info");
  });

  it("gives every legend kind its own entry", () => {
    expect(
      seatingLegendKind(group("g", { kind: "cea", intranetType: "CAS" })),
    ).toBe("cas");
    expect(
      seatingLegendKind(group("g", { kind: "other", intranetType: "cai" })),
    ).toBe("cai");
  });
});

describe("the Mesa", () => {
  it("seats the SE at an AGO and PRES and SE at an AGE", () => {
    const se = group("se", { kind: "cea", acronym: "SE", intranetType: "CEA" });
    const pres = group("pres", {
      kind: "cea",
      acronym: "PRES",
      intranetType: "CEA",
    });
    expect(isMesaOffice(se, "AGO")).toBe(true);
    expect(isMesaOffice(pres, "AGO")).toBe(false);
    expect(isMesaOffice(pres, "AGE")).toBe(true);
    expect(isMesaOffice(se, "AGE")).toBe(true);
    expect(MESA_OFFICE_ACRONYMS.AGO).toEqual(["SE"]);
    // Only an office of the CEA.
    expect(
      isMesaOffice(group("x", { kind: "asociado", acronym: "SE" }), "AGO"),
    ).toBe(false);
  });
});

describe("orderSeatingGroups", () => {
  it("seats the Mesa, the CEA in order, the roll call, the CAS after the sectoriales", () => {
    const groups = [
      group("guest", { kind: "other", name: "Prensa" }),
      group("sect-a", { kind: "sectorial", name: "Asociación A" }),
      group("cas", { kind: "cea", acronym: "CAS", intranetType: "CAS" }),
      group("se", { kind: "cea", acronym: "SE", order: 2 }),
      group("pres", { kind: "cea", acronym: "PRES", order: 1 }),
      group("ub", {
        kind: "asociado",
        name: "CdEUB",
        member: {
          name: "Consejo de Estudiantes",
          university: "Universitat de Barcelona",
        },
      }),
      group("ugr", {
        kind: "asociado",
        name: "CEUGR",
        member: {
          name: "Consejo de Estudiantes",
          university: "Universidad de Granada",
        },
      }),
      group("gone", {
        kind: "asociado",
        name: "Zeta",
        goneAt: "2026-11-15T10:00:00Z",
      }),
      group("mesa", { kind: "mesa" }),
      group("sect-z", { kind: "sectorial", name: "Asociación Z" }),
    ];
    expect(orderSeatingGroups(groups).map((g) => g.id)).toEqual([
      "mesa",
      "pres",
      "se",
      // Reverse alphabetical by denomination and university.
      "ub",
      "ugr",
      "sect-z",
      "sect-a",
      "cas",
      "guest",
      "gone",
    ]);
  });
});

describe("counts", () => {
  const groups = [
    group("ugr", { kind: "asociado", intranetType: "Asociado" }),
    group("cai", { kind: "other", intranetType: "CAI" }),
    group("cas", { kind: "cea", intranetType: "CAS" }),
    group("left", { kind: "asociado", goneAt: "2026-11-15T10:00:00Z" }),
  ];
  const people = [
    person("p1", "ugr"),
    person("p2", "ugr", { status: "pending" }),
    person("p3", "ugr", { needsSeat: false }),
    person("p4", "ugr", { goneAt: "2026-11-15T10:00:00Z" }),
    person("p5", "cai"),
    person("p6", "cas"),
    person("p7", "left"),
  ];
  const assignments = [
    { seatId: "s1", personId: "p1" },
    { seatId: "s5", personId: "p5" },
  ];

  it("counts the header", () => {
    expect(seatingCounts(groups, people, assignments)).toEqual({
      people: 4,
      seated: 2,
      unseated: 2,
      pending: 1,
      notNeeded: 1,
      gone: 2,
    });
  });

  it("counts each group", () => {
    const counts = groupSeatCounts(groups, people, assignments);
    expect(counts.get("ugr")).toEqual({ total: 2, seated: 1, pending: 1 });
    expect(counts.get("left")).toEqual({ total: 0, seated: 0, pending: 0 });
  });

  it("counts each legend kind on its own, colours shared", () => {
    expect(seatingLegend(groups, people, assignments)).toEqual([
      { kind: "asociado", colour: "info", seated: 1, total: 2 },
      { kind: "cai", colour: "info", seated: 1, total: 1 },
      { kind: "cas", colour: "sectorial", seated: 0, total: 1 },
    ]);
  });
});

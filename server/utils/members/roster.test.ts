import { describe, expect, it } from "vitest";
import {
  findLargeDeactivations,
  intranetRosterResponseSchema,
  isDeactivationConfirmed,
  isLargeDeactivation,
  normalizeRoster,
  planRosterSync,
  type ExistingMember,
  type RosterMember,
} from "./roster";

const existing = (overrides: Partial<ExistingMember>): ExistingMember => ({
  id: "m1",
  kind: "asociado",
  acronym: "CEUM",
  name: "Consejo de Estudiantes de la Universidad de Murcia",
  university: "Universidad de Murcia",
  region: "Región de Murcia",
  intranetId: null,
  email: null,
  source: "intranet",
  active: true,
  ...overrides,
});

const entry = (overrides: Partial<RosterMember>): RosterMember => ({
  kind: "asociado",
  acronym: "CEUM",
  name: "Consejo de Estudiantes de la Universidad de Murcia",
  university: "Universidad de Murcia",
  region: "Región de Murcia",
  intranetId: null,
  email: null,
  ...overrides,
});

/** The same member as the roster lists it (nothing to change). */
const listed = (member: ExistingMember): RosterMember => ({
  kind: member.kind as RosterMember["kind"],
  acronym: member.acronym,
  name: member.name,
  university: member.university,
  region: member.region,
  intranetId: member.intranetId,
  email: member.email,
});

describe("intranetRosterResponseSchema", () => {
  it("accepts nullable columns and lists without university", () => {
    const parsed = intranetRosterResponseSchema.parse({
      data: [
        {
          order: 1,
          denomination: "  Consejo  de Estudiantes ",
          initials: "CEUM",
        },
        { order: 2, denomination: null, initials: null, university: null },
      ],
      generated_at: "2026-11-04T10:00:00Z",
    });
    expect(parsed.data[0]).toMatchObject({
      id: null,
      denomination: "Consejo de Estudiantes",
      initials: "CEUM",
      university: null,
      autonomous_community: null,
    });
    expect(parsed.data[1]?.initials).toBeNull();
  });

  it("reads the Intranet id of the private group, null when missing", () => {
    const parsed = intranetRosterResponseSchema.parse({
      data: [
        { id: 412, initials: "CdEUB" },
        { id: null, initials: "CEUM" },
      ],
    });
    expect(parsed.data.map((row) => row.id)).toEqual([412, null]);
  });

  it.each([0, -1, 1.5, "412", 2 ** 31])(
    "rejects the whole list for an id %p",
    (id) => {
      const parsed = intranetRosterResponseSchema.safeParse({
        data: [
          { id: 1, initials: "A" },
          { id, initials: "B" },
        ],
      });
      expect(parsed.success).toBe(false);
    },
  );
});

describe("normalizeRoster", () => {
  it("skips rows without initials and keeps the first of duplicated acronyms", () => {
    const roster = normalizeRoster([
      {
        kind: "asociado",
        entries: [
          {
            id: 10,
            email: null,
            order: 1,
            denomination: "Consejo A",
            initials: "CEUM",
            university: "UM",
            autonomous_community: "Murcia",
          },
          {
            id: 11,
            email: null,
            order: 2,
            denomination: "Sin siglas",
            initials: null,
            university: null,
            autonomous_community: null,
          },
        ],
      },
      {
        kind: "sectorial",
        entries: [
          {
            id: 12,
            email: null,
            order: 1,
            denomination: "Duplicado",
            initials: "ceum",
            university: null,
            autonomous_community: null,
          },
          {
            id: null,
            email: null,
            order: 2,
            denomination: null,
            initials: "CEEM",
            university: null,
            autonomous_community: null,
          },
        ],
      },
    ]);
    expect(roster.skipped).toBe(1);
    expect(roster.duplicates).toEqual(["ceum"]);
    expect(roster.duplicateIds).toEqual([]);
    expect(roster.members).toEqual([
      {
        kind: "asociado",
        acronym: "CEUM",
        name: "Consejo A",
        university: "UM",
        region: "Murcia",
        intranetId: 10,
        email: null,
      },
      {
        kind: "sectorial",
        acronym: "CEEM",
        name: "CEEM",
        university: null,
        region: null,
        intranetId: null,
        email: null,
      },
    ]);
  });

  it("keeps the first row of a repeated Intranet id", () => {
    const row = {
      email: null,
      order: null,
      denomination: null,
      university: null,
      autonomous_community: null,
    };
    const roster = normalizeRoster([
      { kind: "asociado", entries: [{ ...row, id: 7, initials: "A" }] },
      { kind: "sectorial", entries: [{ ...row, id: 7, initials: "B" }] },
    ]);
    expect(roster.members.map((member) => member.acronym)).toEqual(["A"]);
    expect(roster.duplicateIds).toEqual([7]);
    expect(roster.duplicates).toEqual([]);
  });

  it("keeps an email lowercased, once, and drops what is not one", () => {
    const row = {
      order: null,
      denomination: null,
      university: null,
      autonomous_community: null,
    };
    const roster = normalizeRoster([
      {
        kind: "asociado",
        entries: [
          { ...row, id: 1, initials: "A", email: "consejo@uni.es" },
          { ...row, id: 2, initials: "B", email: "consejo@uni.es" },
        ],
      },
    ]);
    expect(roster.members.map((member) => member.email)).toEqual([
      "consejo@uni.es",
      null,
    ]);
    const parsed = intranetRosterResponseSchema.parse({
      data: [
        { id: 1, initials: "A", email: " CdEUB@UB.edu " },
        { id: 2, initials: "B", email: "no es un correo" },
        { id: 3, initials: "C", email: 7 },
        { id: 4, initials: "D" },
      ],
    });
    expect(parsed.data.map((entry) => entry.email)).toEqual([
      "cdeub@ub.edu",
      null,
      null,
      null,
    ]);
  });
});

describe("planRosterSync", () => {
  it("creates, updates, reactivates and deactivates intranet members only", () => {
    const plan = planRosterSync(
      [
        entry({ name: "Nuevo nombre" }),
        entry({
          acronym: "ceule",
          name: "Consejo de León",
          university: null,
          region: null,
        }),
        entry({
          acronym: "UGR",
          name: "Delegación UGR",
          university: null,
          region: null,
        }),
        entry({
          kind: "sectorial",
          acronym: "VPU",
          name: "Colisión",
          university: null,
          region: null,
        }),
      ],
      [
        existing({ id: "m1" }),
        existing({
          id: "m2",
          acronym: "CEULE",
          name: "Consejo de León",
          university: null,
          region: null,
          active: false,
        }),
        existing({ id: "m3", acronym: "CAUB" }),
        existing({
          id: "m4",
          acronym: "VPU",
          kind: "executive",
          source: "manual",
        }),
        existing({
          id: "m5",
          acronym: "AREA",
          kind: "executive",
          source: "manual",
        }),
      ],
    );
    expect(plan.create.map((member) => member.acronym)).toEqual(["UGR"]);
    expect(plan.update.map((change) => change.id)).toEqual(["m1", "m2"]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.deactivate).toEqual(["m3"]);
    expect(plan.manualConflicts).toEqual(["VPU"]);
    expect(plan.acronymConflicts).toEqual([]);
  });

  it("only touches syncedAt when nothing changed", () => {
    const member = existing({ intranetId: 4 });
    const plan = planRosterSync([listed(member)], [member]);
    expect(plan.unchanged).toEqual(["m1"]);
    expect(plan.update).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it("follows an acronym change through the Intranet id", () => {
    const member = existing({ id: "m1", acronym: "CEUM", intranetId: 412 });
    const plan = planRosterSync(
      [entry({ acronym: "CEUMU", intranetId: 412 })],
      [member],
    );
    expect(plan.update).toEqual([
      {
        id: "m1",
        values: entry({ acronym: "CEUMU", intranetId: 412 }),
      },
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it("stores the Intranet id on the member it matches by acronym", () => {
    const member = existing({ intranetId: null });
    const plan = planRosterSync(
      [{ ...listed(member), intranetId: 412 }],
      [member],
    );
    expect(plan.update).toEqual([
      { id: "m1", values: { ...listed(member), intranetId: 412 } },
    ]);
    expect(plan.replacedIds).toEqual([]);
  });

  it("never clears a stored id when the roster sends none", () => {
    const member = existing({ intranetId: 412 });
    const plan = planRosterSync(
      [{ ...listed(member), intranetId: null }],
      [member],
    );
    expect(plan.unchanged).toEqual(["m1"]);
    expect(plan.update).toEqual([]);
  });

  it("never hands a member to another account that takes its acronym", () => {
    // The council that left keeps its documents: the new one waits until
    // its acronym is free, and the members page warns.
    const member = existing({ intranetId: 5 });
    const plan = planRosterSync(
      [{ ...listed(member), intranetId: 9 }],
      [member],
    );
    expect(plan.update).toEqual([]);
    expect(plan.replacedIds).toEqual([]);
    expect(plan.deactivate).toEqual(["m1"]);
    expect(plan.create).toEqual([]);
    expect(plan.acronymConflicts).toEqual(["CEUM"]);
  });

  it("never hands a member to another email by its acronym", () => {
    const member = existing({ email: "viejo@uni.es" });
    const plan = planRosterSync(
      [{ ...listed(member), email: "nuevo@uni.es" }],
      [member],
    );
    expect(plan.update).toEqual([]);
    expect(plan.acronymConflicts).toEqual(["CEUM"]);
  });

  it("follows an account recreated with a new id through its email", () => {
    const member = existing({ intranetId: 5, email: "ceum@um.es" });
    const plan = planRosterSync(
      [{ ...listed(member), acronym: "CEUMU", intranetId: 9 }],
      [member],
    );
    expect(plan.update).toEqual([
      {
        id: "m1",
        values: { ...listed(member), acronym: "CEUMU", intranetId: 9 },
      },
    ]);
    expect(plan.replacedIds).toEqual([
      { id: "m1", acronym: "CEUM", from: 5, to: 9 },
    ]);
    expect(plan.deactivate).toEqual([]);
  });

  it("stores the email the roster sends, once per member", () => {
    const first = existing({ id: "m1", intranetId: 1 });
    const second = existing({
      id: "m2",
      acronym: "CEUB",
      intranetId: 2,
      email: "comun@uni.es",
    });
    const plan = planRosterSync(
      [
        { ...listed(first), email: "comun@uni.es" },
        { ...listed(second), email: "ceub@ub.edu" },
        entry({ acronym: "NEW", intranetId: 3, email: "ceub@ub.edu" }),
      ],
      [first, second],
    );
    // m1 cannot take an address m2 still stores, nor the new entry one m2
    // takes now.
    expect(plan.unchanged).toEqual(["m1"]);
    expect(plan.update).toEqual([
      { id: "m2", values: { ...listed(second), email: "ceub@ub.edu" } },
    ]);
    expect(plan.create).toEqual([
      entry({ acronym: "NEW", intranetId: 3, email: null }),
    ]);
  });

  it("creates the entry that takes the acronym of a member renamed under its id", () => {
    const plan = planRosterSync(
      [
        entry({ acronym: "CEUM", intranetId: 9, name: "Otro consejo" }),
        entry({ acronym: "CEUM2", intranetId: 5 }),
      ],
      [existing({ id: "m1", acronym: "CEUM", intranetId: 5 })],
    );
    expect(plan.update.map(({ id, values }) => [id, values.acronym])).toEqual([
      ["m1", "CEUM2"],
    ]);
    expect(
      plan.create.map((member) => [member.acronym, member.intranetId]),
    ).toEqual([["CEUM", 9]]);
    expect(plan.deactivate).toEqual([]);
  });

  it("applies a swap of acronyms between two members matched by id", () => {
    const plan = planRosterSync(
      [
        entry({ acronym: "B", intranetId: 1 }),
        entry({ acronym: "A", intranetId: 2 }),
      ],
      [
        existing({ id: "ma", acronym: "A", intranetId: 1 }),
        existing({ id: "mb", acronym: "B", intranetId: 2 }),
      ],
    );
    expect(plan.update.map(({ id, values }) => [id, values.acronym])).toEqual([
      ["ma", "B"],
      ["mb", "A"],
    ]);
    expect(plan.acronymConflicts).toEqual([]);
  });

  it("keeps the acronym of a member renamed onto one another member keeps", () => {
    const plan = planRosterSync(
      [entry({ acronym: "B", intranetId: 1 })],
      [
        existing({ id: "ma", acronym: "A", intranetId: 1 }),
        // No longer listed: deactivated, but it keeps "B".
        existing({ id: "mb", acronym: "B", intranetId: 2 }),
      ],
    );
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toEqual(["ma"]);
    expect(plan.deactivate).toEqual(["mb"]);
    expect(plan.acronymConflicts).toEqual(["B"]);
  });

  it("never renames onto a manual member's acronym", () => {
    const plan = planRosterSync(
      [entry({ acronym: "VPU", intranetId: 1, name: "Nuevo" })],
      [
        existing({ id: "ma", acronym: "A", intranetId: 1 }),
        existing({ id: "mv", acronym: "VPU", source: "manual" }),
      ],
    );
    expect(plan.update.map(({ id, values }) => [id, values.acronym])).toEqual([
      ["ma", "A"],
    ]);
    expect(plan.manualConflicts).toEqual(["VPU"]);
    expect(plan.deactivate).toEqual([]);
  });

  it("follows a blocked rename down a chain and does not create onto it", () => {
    // ma wants "B", which mb keeps because its own "C" is manual. The new
    // entry "A" cannot be created while ma keeps "A".
    const plan = planRosterSync(
      [
        entry({ acronym: "B", intranetId: 1 }),
        entry({ acronym: "C", intranetId: 2 }),
        entry({ acronym: "A", intranetId: 3 }),
      ],
      [
        existing({ id: "ma", acronym: "A", intranetId: 1 }),
        existing({ id: "mb", acronym: "B", intranetId: 2 }),
        existing({ id: "mc", acronym: "C", source: "manual" }),
      ],
    );
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toEqual(["ma", "mb"]);
    expect(plan.create).toEqual([]);
    expect(plan.manualConflicts).toEqual(["C"]);
    expect(plan.acronymConflicts).toEqual(["B", "A"]);
    expect(plan.deactivate).toEqual([]);
  });

  it("never touches a manual member, even through an Intranet id", () => {
    const manual = existing({ id: "mv", source: "manual", intranetId: 7 });
    const plan = planRosterSync(
      [entry({ acronym: "OTRO", intranetId: 7 })],
      [manual],
    );
    expect(plan.update).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.manualConflicts).toEqual(["CEUM"]);
  });
});

describe("isLargeDeactivation", () => {
  it.each([
    // [active, toDeactivate, large]
    [0, 0, false],
    [5, 0, false],
    [1, 1, true],
    [2, 2, true],
    [3, 3, true],
    [4, 3, false],
    [10, 3, false],
    [10, 4, true],
    [20, 6, false],
    [20, 7, true],
    [100, 30, false],
    [100, 31, true],
  ])("%i active, %i leaving: %s", (active, toDeactivate, large) => {
    expect(isLargeDeactivation(active, toDeactivate)).toBe(large);
  });
});

describe("findLargeDeactivations", () => {
  const sectorials = Array.from({ length: 10 }, (_, index) =>
    existing({
      id: `s${index}`,
      kind: "sectorial",
      acronym: `S${index}`,
    }),
  );

  it("reports each roster kind over the limit with its counts", () => {
    const members = [
      existing({ id: "a1" }),
      existing({ id: "a2", acronym: "B" }),
      ...sectorials,
    ];
    expect(
      findLargeDeactivations(members, ["a1", "a2", "s0", "s1", "s2", "s3"]),
    ).toEqual([
      { kind: "asociado", active: 2, toDeactivate: 2 },
      { kind: "sectorial", active: 10, toDeactivate: 4 },
    ]);
    expect(findLargeDeactivations(members, ["a1", "s0", "s1", "s2"])).toEqual(
      [],
    );
  });

  it("counts only active intranet members of the kind", () => {
    const members = [
      existing({ id: "a1" }),
      existing({ id: "a2", acronym: "B", active: false }),
      existing({ id: "a3", acronym: "C", source: "manual" }),
      existing({ id: "e1", acronym: "E", kind: "executive" }),
      existing({ id: "e2", acronym: "F", kind: "executive", source: "manual" }),
    ];
    expect(findLargeDeactivations(members, ["a1", "e1"])).toEqual([
      { kind: "asociado", active: 1, toDeactivate: 1 },
      { kind: "executive", active: 1, toDeactivate: 1 },
    ]);
  });
});

describe("isDeactivationConfirmed", () => {
  const large = [
    { kind: "asociado" as const, active: 100, toDeactivate: 100 },
    { kind: "sectorial" as const, active: 12, toDeactivate: 6 },
  ];

  it("needs every kind confirmed with at least as many members", () => {
    expect(
      isDeactivationConfirmed(large, [
        { kind: "asociado", toDeactivate: 100 },
        { kind: "sectorial", toDeactivate: 8 },
      ]),
    ).toBe(true);
    expect(
      isDeactivationConfirmed(large, [{ kind: "asociado", toDeactivate: 100 }]),
    ).toBe(false);
    expect(isDeactivationConfirmed(large, [])).toBe(false);
  });

  it("never stretches a confirmation of 5 to 100", () => {
    expect(
      isDeactivationConfirmed(
        [{ kind: "asociado", active: 100, toDeactivate: 100 }],
        [{ kind: "asociado", toDeactivate: 5 }],
      ),
    ).toBe(false);
  });

  it("needs nothing when there is nothing large", () => {
    expect(isDeactivationConfirmed([], [])).toBe(true);
  });
});

describe("planRosterSync with the CEA list", () => {
  const office = (overrides: Partial<ExistingMember>): ExistingMember =>
    existing({
      kind: "executive",
      university: null,
      region: null,
      ...overrides,
    });
  const listed = (
    acronym: string,
    intranetId: number,
    name = acronym,
  ): RosterMember => ({
    kind: "executive",
    acronym,
    name,
    university: null,
    region: null,
    intranetId,
    email: null,
  });

  it("adopts a manual office the list names and deactivates one it dropped", () => {
    const plan = planRosterSync(
      [listed("PRES", 100, "Presidencia"), listed("SE", 101)],
      [
        office({
          id: "m-pres",
          acronym: "PRES",
          name: "PRES",
          source: "manual",
        }),
        office({ id: "m-old", acronym: "VOLD", intranetId: 90 }),
        office({ id: "m-hand", acronym: "VHAND", source: "manual" }),
      ],
    );
    expect(plan.update).toEqual([
      {
        id: "m-pres",
        adopt: true,
        values: listed("PRES", 100, "Presidencia"),
      },
    ]);
    expect(plan.create.map((entry) => entry.acronym)).toEqual(["SE"]);
    // An office the Intranet dropped goes; one made by hand stays.
    expect(plan.deactivate).toEqual(["m-old"]);
    expect(plan.manualConflicts).toEqual([]);
  });

  it("never adopts a manual member of another kind", () => {
    const plan = planRosterSync(
      [listed("CAS", 102)],
      [
        existing({
          id: "m-cas",
          acronym: "CAS",
          kind: "other",
          source: "manual",
        }),
      ],
    );
    expect(plan.update).toEqual([]);
    expect(plan.manualConflicts).toEqual(["CAS"]);
  });

  it("lets the CAS list adopt the manual member CAS", () => {
    const cas: RosterMember = {
      ...listed("CAS", 102, "Comité de Asuntos Sectoriales"),
      kind: "other",
    };
    const plan = planRosterSync(
      [cas],
      [
        existing({
          id: "m-cas",
          acronym: "CAS",
          kind: "other",
          source: "manual",
        }),
        existing({
          id: "m-mesa",
          acronym: "MESA",
          kind: "other",
          source: "manual",
        }),
      ],
      ["asociado", "sectorial", "executive", "other"],
    );
    expect(plan.update).toEqual([{ id: "m-cas", adopt: true, values: cas }]);
    // Any other manual member stays as it is.
    expect(plan.deactivate).toEqual([]);
    expect(plan.manualConflicts).toEqual([]);
  });

  it("deactivates no office when the Intranet did not give the list", () => {
    const plan = planRosterSync(
      [],
      [office({ id: "m-old", acronym: "VOLD", intranetId: 90 })],
      ["asociado", "sectorial"],
    );
    expect(plan.deactivate).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  intranetRosterResponseSchema,
  normalizeRoster,
  planRosterSync,
  type ExistingMember,
} from "./roster";

const existing = (overrides: Partial<ExistingMember>): ExistingMember => ({
  id: "m1",
  kind: "asociado",
  acronym: "CEUM",
  name: "Consejo de Estudiantes de la Universidad de Murcia",
  university: "Universidad de Murcia",
  region: "Región de Murcia",
  source: "intranet",
  active: true,
  ...overrides,
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
      denomination: "Consejo de Estudiantes",
      initials: "CEUM",
      university: null,
      autonomous_community: null,
    });
    expect(parsed.data[1]?.initials).toBeNull();
  });
});

describe("normalizeRoster", () => {
  it("skips rows without initials and keeps the first of duplicated acronyms", () => {
    const roster = normalizeRoster([
      {
        kind: "asociado",
        entries: [
          {
            order: 1,
            denomination: "Consejo A",
            initials: "CEUM",
            university: "UM",
            autonomous_community: "Murcia",
          },
          {
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
            order: 1,
            denomination: "Duplicado",
            initials: "ceum",
            university: null,
            autonomous_community: null,
          },
          {
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
    expect(roster.members).toEqual([
      {
        kind: "asociado",
        acronym: "CEUM",
        name: "Consejo A",
        university: "UM",
        region: "Murcia",
      },
      {
        kind: "sectorial",
        acronym: "CEEM",
        name: "CEEM",
        university: null,
        region: null,
      },
    ]);
  });
});

describe("planRosterSync", () => {
  it("creates, updates, reactivates and deactivates intranet members only", () => {
    const plan = planRosterSync(
      [
        {
          kind: "asociado",
          acronym: "CEUM",
          name: "Nuevo nombre",
          university: "Universidad de Murcia",
          region: "Región de Murcia",
        },
        {
          kind: "asociado",
          acronym: "ceule",
          name: "Consejo de León",
          university: null,
          region: null,
        },
        {
          kind: "asociado",
          acronym: "UGR",
          name: "Delegación UGR",
          university: null,
          region: null,
        },
        {
          kind: "sectorial",
          acronym: "VPU",
          name: "Colisión",
          university: null,
          region: null,
        },
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
    expect(plan.update.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.deactivate).toEqual(["m3"]);
    expect(plan.manualConflicts).toEqual(["VPU"]);
  });

  it("only touches syncedAt when nothing changed", () => {
    const member = existing({});
    const plan = planRosterSync(
      [
        {
          kind: "asociado",
          acronym: member.acronym,
          name: member.name,
          university: member.university,
          region: member.region,
        },
      ],
      [member],
    );
    expect(plan.unchanged).toEqual(["m1"]);
    expect(plan.update).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });
});

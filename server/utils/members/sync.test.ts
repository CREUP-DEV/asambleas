import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";

// syncIntranetRoster with the intranet and the database stubbed: what it
// records for each member, not how it queries.
const existing = [
  {
    id: "m-ceum",
    kind: "asociado",
    acronym: "CEUM",
    name: "Consejo antiguo",
    university: "Universidad de Murcia",
    region: "Región de Murcia",
    source: "intranet",
    active: true,
  },
  {
    id: "m-old",
    kind: "sectorial",
    acronym: "OLD",
    name: "Sectorial que ya no está",
    university: null,
    region: null,
    source: "intranet",
    active: true,
  },
  {
    id: "m-cea",
    kind: "executive",
    acronym: "CEA",
    name: "Área ejecutiva",
    university: null,
    region: null,
    source: "manual",
    active: true,
  },
];

const recordAudit = vi.fn(async () => "audit-id");
const tx = {
  select: () => ({ from: () => ({ for: async () => existing }) }),
  insert: () => ({
    values: (rows: Record<string, unknown>[]) => ({
      returning: async () =>
        rows.map((row, index) => ({ id: `m-new-${index}`, ...row })),
    }),
  }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
};

vi.mock("../../db", () => ({
  db: {
    transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx),
  },
}));
vi.mock("../domain/audit", () => ({ recordAudit }));
vi.mock("../core/logger", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("./intranet", () => ({
  IntranetUnavailableError: class extends Error {},
  getIntranetApiBaseUrl: () => "https://intranet.test",
  fetchIntranetRoster: async (_base: string, kind: string) =>
    kind === "asociado"
      ? [
          {
            initials: "CEUM",
            denomination: "Consejo de Estudiantes de la Universidad de Murcia",
            university: "Universidad de Murcia",
            autonomous_community: "Región de Murcia",
          },
          {
            initials: "CEUNEW",
            denomination: "Consejo nuevo",
            university: "Universidad Nueva",
            autonomous_community: null,
          },
        ]
      : [
          {
            initials: "CEA",
            denomination: "No toca al manual",
            university: null,
            autonomous_community: null,
          },
        ],
}));

const { memberAuditState, syncIntranetRoster } = await import("./sync");

type AuditInput = Record<string, unknown> & {
  after: Record<string, unknown>;
};
const audits = () =>
  (recordAudit.mock.calls as unknown as [unknown, AuditInput][]).map(
    ([, input]) => input,
  );

beforeEach(() => {
  recordAudit.mockClear();
});

describe("memberAuditState", () => {
  it("leaves out the timestamps every write moves", () => {
    const state = memberAuditState({
      ...existing[0]!,
      kind: "asociado",
      source: "intranet",
    });
    expect(state).toEqual({
      kind: "asociado",
      acronym: "CEUM",
      name: "Consejo antiguo",
      university: "Universidad de Murcia",
      region: "Región de Murcia",
      source: "intranet",
      active: true,
    });
  });
});

describe("syncIntranetRoster traceability", () => {
  it("writes one row per changed member and a summary, all in one batch", async () => {
    const actor = { user: { id: "secretaria" }, impersonation: null };
    const result = await syncIntranetRoster({ actor });
    expect(result).toEqual({ created: 1, updated: 1, deactivated: 1 });

    const rows = audits();
    expect(rows.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.MEMBER_SYNC_CREATE,
      AUDIT_ACTIONS.MEMBER_SYNC_UPDATE,
      AUDIT_ACTIONS.MEMBER_SYNC_DEACTIVATE,
      AUDIT_ACTIONS.MEMBERS_SYNC,
    ]);
    const batchId = rows[0]!.after.batchId;
    expect(typeof batchId).toBe("string");
    for (const row of rows) {
      expect(row).toMatchObject({ actor, source: "intranet" });
      expect(row.after.batchId).toBe(batchId);
    }

    expect(rows[0]).toMatchObject({
      targetType: "member",
      targetId: "m-new-0",
      before: null,
      after: { acronym: "CEUNEW", name: "Consejo nuevo", active: true },
    });
    expect(rows[1]).toMatchObject({
      targetType: "member",
      targetId: "m-ceum",
      before: { name: "Consejo antiguo" },
      after: {
        name: "Consejo de Estudiantes de la Universidad de Murcia",
        source: "intranet",
        active: true,
      },
    });
    expect(rows[2]).toMatchObject({
      targetType: "member",
      targetId: "m-old",
      before: { active: true },
      after: { active: false },
    });
    expect(rows[3]).toMatchObject({
      targetType: "members",
      targetId: "intranet",
      after: {
        created: 1,
        updated: 1,
        deactivated: 1,
        unchanged: 0,
        manualConflicts: ["CEA"],
      },
    });
  });
});

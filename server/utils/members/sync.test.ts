import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";

// syncIntranetRoster with the intranet and the database stubbed: what it
// records for each member and in which order it writes, not how it queries.

interface StoredMember {
  id: string;
  kind: string;
  acronym: string;
  name: string;
  university: string | null;
  region: string | null;
  intranetId: number | null;
  source: string;
  active: boolean;
}

interface RosterRow {
  id?: number | null;
  initials: string;
  denomination: string | null;
  university?: string | null;
  autonomous_community?: string | null;
}

const stored = (
  overrides: Partial<StoredMember> & Pick<StoredMember, "id" | "acronym">,
): StoredMember => ({
  kind: "sectorial",
  name: overrides.acronym,
  university: null,
  region: null,
  intranetId: null,
  source: "intranet",
  active: true,
  ...overrides,
});

const sectorialRow = (initials: string): RosterRow => ({
  initials,
  denomination: initials,
});

let existing: StoredMember[] = [];
let roster: { asociado: RosterRow[]; sectorial: RosterRow[] } = {
  asociado: [],
  sectorial: [],
};

/** Each write the transaction made, in order. */
let writes: string[] = [];

const recordAudit = vi.fn(async () => "audit-id");
const execute = vi.fn(async () => undefined);
const tx = {
  execute,
  select: () => ({ from: () => ({ for: async () => existing }) }),
  insert: () => ({
    values: (rows: Record<string, unknown>[]) => {
      writes.push(`insert ${rows.map((row) => row.acronym).join(",")}`);
      return {
        returning: async () =>
          rows.map((row, index) => ({ id: `m-new-${index}`, ...row })),
      };
    },
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        writes.push(
          "acronym" in values
            ? `update acronym ${String(values.acronym)}`
            : `update ${Object.keys(values).join(",")}`,
        );
      },
    }),
  }),
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
  fetchIntranetRoster: async (_base: string, kind: "asociado" | "sectorial") =>
    roster[kind].map((row) => ({
      id: row.id ?? null,
      order: null,
      university: null,
      autonomous_community: null,
      ...row,
    })),
}));

const { memberAuditState, syncIntranetRoster } = await import("./sync");

type AuditInput = Record<string, unknown> & {
  after: Record<string, unknown>;
};
const audits = () =>
  (recordAudit.mock.calls as unknown as [unknown, AuditInput][]).map(
    ([, input]) => input,
  );

/**
 * One asociado to update, one to create, a sectorial to deactivate out of
 * three (below the safeguard) and a roster acronym held by a manual member.
 */
function baseFixture(): void {
  existing = [
    stored({
      id: "m-ceum",
      kind: "asociado",
      acronym: "CEUM",
      name: "Consejo antiguo",
      university: "Universidad de Murcia",
      region: "Región de Murcia",
    }),
    stored({ id: "m-old", acronym: "OLD" }),
    stored({ id: "m-s1", acronym: "S1" }),
    stored({ id: "m-s2", acronym: "S2" }),
    stored({
      id: "m-cea",
      kind: "executive",
      acronym: "CEA",
      name: "Área ejecutiva",
      source: "manual",
    }),
  ];
  roster = {
    asociado: [
      {
        id: 412,
        initials: "CEUM",
        denomination: "Consejo de Estudiantes de la Universidad de Murcia",
        university: "Universidad de Murcia",
        autonomous_community: "Región de Murcia",
      },
      {
        id: 413,
        initials: "CEUNEW",
        denomination: "Consejo nuevo",
        university: "Universidad Nueva",
      },
    ],
    sectorial: [
      sectorialRow("S1"),
      sectorialRow("S2"),
      { initials: "CEA", denomination: "No toca al manual" },
    ],
  };
}

beforeEach(() => {
  recordAudit.mockClear();
  execute.mockClear();
  writes = [];
  baseFixture();
});

describe("memberAuditState", () => {
  it("keeps the Intranet id and leaves out the timestamps every write moves", () => {
    const state = memberAuditState({
      kind: "asociado",
      acronym: "CEUM",
      name: "Consejo antiguo",
      university: "Universidad de Murcia",
      region: "Región de Murcia",
      intranetId: 412,
      source: "intranet",
      active: true,
    });
    expect(state).toEqual({
      kind: "asociado",
      acronym: "CEUM",
      name: "Consejo antiguo",
      university: "Universidad de Murcia",
      region: "Región de Murcia",
      intranetId: 412,
      source: "intranet",
      active: true,
    });
  });
});

describe("syncIntranetRoster traceability", () => {
  it("writes one row per changed member and a summary, all in one batch", async () => {
    const actor = { user: { id: "secretaria" }, impersonation: null };
    const outcome = await syncIntranetRoster({ actor });
    expect(outcome).toEqual({
      status: "applied",
      result: { created: 1, updated: 1, deactivated: 1 },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const rows = audits();
    expect(rows.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.MEMBER_SYNC_UPDATE,
      AUDIT_ACTIONS.MEMBER_SYNC_CREATE,
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
      targetId: "m-ceum",
      before: { name: "Consejo antiguo", intranetId: null },
      after: {
        name: "Consejo de Estudiantes de la Universidad de Murcia",
        intranetId: 412,
        source: "intranet",
        active: true,
      },
    });
    expect(rows[1]).toMatchObject({
      targetType: "member",
      targetId: "m-new-0",
      before: null,
      after: {
        acronym: "CEUNEW",
        name: "Consejo nuevo",
        intranetId: 413,
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
        unchanged: 2,
        manualConflicts: ["CEA"],
        acronymConflicts: [],
        trigger: "manual",
        confirmedDeactivation: false,
      },
    });
  });
});

describe("syncIntranetRoster safeguard", () => {
  beforeEach(() => {
    // Every active sectorial would go.
    roster.sectorial = [];
  });

  it("writes nothing but members.sync_blocked without confirmation", async () => {
    const actor = { user: { id: "secretaria" }, impersonation: null };
    const outcome = await syncIntranetRoster({ actor });

    const kinds = [{ kind: "sectorial", active: 3, toDeactivate: 3 }];
    expect(outcome).toEqual({ status: "blocked", kinds });
    expect(writes).toEqual([]);
    expect(audits()).toEqual([
      {
        event: undefined,
        actor,
        source: "intranet",
        action: AUDIT_ACTIONS.MEMBERS_SYNC_BLOCKED,
        targetType: "members",
        targetId: "intranet",
        after: { reason: "large_deactivation", kinds, trigger: "manual" },
      },
    ]);
  });

  it("applies the sync when the account confirms it", async () => {
    const outcome = await syncIntranetRoster({
      actor: { user: { id: "secretaria" }, impersonation: null },
      confirmDeactivation: true,
      confirmedKinds: [{ kind: "sectorial", toDeactivate: 3 }],
    });
    expect(outcome).toEqual({
      status: "applied",
      result: { created: 1, updated: 1, deactivated: 3 },
    });
    const summary = audits().at(-1)!;
    expect(summary).toMatchObject({
      action: AUDIT_ACTIONS.MEMBERS_SYNC,
      after: { deactivated: 3, confirmedDeactivation: true },
    });
  });

  it("needs the counts with the confirmation", async () => {
    const outcome = await syncIntranetRoster({
      actor: { user: { id: "secretaria" }, impersonation: null },
      confirmDeactivation: true,
    });
    expect(outcome.status).toBe("blocked");
    expect(writes).toEqual([]);
  });

  it("refuses again when the retry would deactivate more than was confirmed", async () => {
    // The dialog showed 5 of 100 asociados (a partial list); on the retry
    // the Intranet answered with an empty one.
    existing = Array.from({ length: 100 }, (_, index) =>
      stored({
        id: `m-a${index}`,
        kind: "asociado",
        acronym: `A${index}`,
        intranetId: index + 1,
      }),
    );
    roster = { asociado: [], sectorial: [] };
    const actor = { user: { id: "secretaria" }, impersonation: null };

    const outcome = await syncIntranetRoster({
      actor,
      confirmDeactivation: true,
      confirmedKinds: [{ kind: "asociado", toDeactivate: 5 }],
    });

    const kinds = [{ kind: "asociado", active: 100, toDeactivate: 100 }];
    expect(outcome).toEqual({ status: "blocked", kinds });
    expect(writes).toEqual([]);
    expect(audits()).toEqual([
      expect.objectContaining({
        actor,
        action: AUDIT_ACTIONS.MEMBERS_SYNC_BLOCKED,
        after: { reason: "large_deactivation", kinds, trigger: "manual" },
      }),
    ]);
  });

  it("applies a retry that deactivates no more than was confirmed", async () => {
    const outcome = await syncIntranetRoster({
      actor: { user: { id: "secretaria" }, impersonation: null },
      confirmDeactivation: true,
      confirmedKinds: [{ kind: "sectorial", toDeactivate: 10 }],
    });
    expect(outcome.status).toBe("applied");
  });

  it("never confirms a scheduled run, which has no actor", async () => {
    const outcome = await syncIntranetRoster({
      event: null,
      actor: null,
      trigger: "scheduled",
      confirmDeactivation: true,
      confirmedKinds: [{ kind: "sectorial", toDeactivate: 3 }],
    });
    expect(outcome.status).toBe("blocked");
    expect(writes).toEqual([]);
    expect(audits()).toEqual([
      expect.objectContaining({
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.MEMBERS_SYNC_BLOCKED,
        after: expect.objectContaining({ trigger: "scheduled" }),
      }),
    ]);
  });

  it("applies a scheduled run below the limit with no actor", async () => {
    baseFixture();
    const outcome = await syncIntranetRoster({
      event: null,
      actor: null,
      trigger: "scheduled",
    });
    expect(outcome.status).toBe("applied");
    for (const row of audits()) {
      expect(row).toMatchObject({ actor: null, source: "intranet" });
    }
    expect(audits().at(-1)!.after).toMatchObject({ trigger: "scheduled" });
  });
});

describe("syncIntranetRoster write order", () => {
  it("renames a member under its id before inserting the entry that takes its acronym", async () => {
    existing = [
      stored({ id: "m-a", kind: "asociado", acronym: "A", intranetId: 5 }),
    ];
    roster = {
      asociado: [
        { id: 9, initials: "A", denomination: "Otro" },
        { id: 5, initials: "A2", denomination: "A" },
      ],
      sectorial: [],
    };
    const outcome = await syncIntranetRoster({ actor: null });
    expect(outcome).toEqual({
      status: "applied",
      result: { created: 1, updated: 1, deactivated: 0 },
    });
    expect(writes).toEqual(["update acronym A2", "insert A"]);
  });

  it("moves swapped acronyms through placeholders, so no statement collides", async () => {
    existing = [
      stored({ id: "m-a", kind: "asociado", acronym: "A", intranetId: 1 }),
      stored({ id: "m-b", kind: "asociado", acronym: "B", intranetId: 2 }),
    ];
    roster = {
      asociado: [
        { id: 1, initials: "B", denomination: "A" },
        { id: 2, initials: "A", denomination: "B" },
      ],
      sectorial: [],
    };
    await syncIntranetRoster({ actor: null });
    expect(writes).toEqual([
      "update acronym ~roster-sync~m-a",
      "update acronym ~roster-sync~m-b",
      "update acronym B",
      "update acronym A",
    ]);
  });
});

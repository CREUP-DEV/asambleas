import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

// syncUserRole with a stubbed database: what it records, not how it queries.
interface FreshUser {
  id: string;
  email: string;
  roleId: string | null;
  memberId: string | null;
  externalRole: string | null;
  externalName: string | null;
  externalInitials: string | null;
  university: string | null;
  role: { name: string } | null;
}

let freshUser: FreshUser;
const updates: Record<string, unknown>[] = [];
const recordAudit = vi.fn(async () => "audit-id");
const tx = {
  execute: vi.fn(async () => undefined),
  query: {
    users: { findFirst: vi.fn(async () => freshUser) },
    roles: { findFirst: vi.fn(async () => ({ id: "role-new" })) },
  },
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updates.push(values);
      },
    }),
  }),
};

vi.mock("../../db", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn(async () => ({ email: freshUser.email })) },
    },
    transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx),
  },
}));
vi.mock("../domain/audit", () => ({ recordAudit }));
vi.mock("../core/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
// The real intranet client answers through the stubbed fetch.
vi.mock("./impersonation", () => ({
  endImpersonations: vi.fn(async () => []),
}));
vi.mock("../members/link", () => ({
  INTRANET_MEMBER_TYPES: new Map([
    ["Asociado", "asociado"],
    ["Sectorial", "sectorial"],
    ["CEA", "executive"],
  ]),
  linkUserToIntranetMember: vi.fn(async () => null),
}));

const { syncUserRole } = await import("./roleSync");

function answer(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const auditCall = (action: string) =>
  (recordAudit.mock.calls as unknown as [unknown, Record<string, unknown>][])
    .map(([, input]) => input)
    .find((input) => input.action === action);

beforeEach(() => {
  updates.length = 0;
  recordAudit.mockClear();
  vi.stubEnv("INITIAL_ADMIN_EMAIL", "tic@creup.es");
  vi.stubEnv("NUXT_INTRANET_API_URL", "");
  vi.stubEnv("NUXT_INTRANET_API_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("syncUserRole traceability", () => {
  it("records the initial Admin and the sync, with the intranet unconfigured", async () => {
    vi.stubEnv("NUXT_ROLE_API_URL", "");
    freshUser = {
      id: "u1",
      email: "tic@creup.es",
      roleId: null,
      memberId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      role: null,
    };

    expect(await syncUserRole("u1")).toBe("unconfigured");
    expect(updates[0]).toMatchObject({ roleId: "role-new" });
    expect(auditCall(AUDIT_ACTIONS.USER_INITIAL_ADMIN)).toMatchObject({
      actor: null,
      source: "intranet",
      targetType: "user",
      targetId: "u1",
      before: { roleName: null },
      after: { roleName: SYSTEM_ROLES.ADMIN },
    });
    expect(auditCall(AUDIT_ACTIONS.USER_ROLE_SYNC)).toMatchObject({
      actor: null,
      source: "intranet",
      before: { roleName: null },
      after: { roleName: SYSTEM_ROLES.ADMIN },
    });
  });

  it("does not call an Invitado fallback an initial Admin", async () => {
    // The Admin role row is missing (database not seeded): the new account
    // falls back to Invitado.
    vi.stubEnv("NUXT_ROLE_API_URL", "");
    tx.query.roles.findFirst.mockResolvedValueOnce(
      undefined as unknown as { id: string },
    );
    freshUser = {
      id: "u1",
      email: "tic@creup.es",
      roleId: null,
      memberId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
      role: null,
    };

    await syncUserRole("u1");
    expect(auditCall(AUDIT_ACTIONS.USER_INITIAL_ADMIN)).toBeUndefined();
    expect(auditCall(AUDIT_ACTIONS.USER_ROLE_SYNC)).toMatchObject({
      before: { roleName: null },
      after: { roleName: SYSTEM_ROLES.INVITADO },
    });
  });

  it("records a role that follows the intranet type, and the unlink", async () => {
    vi.stubEnv("NUXT_ROLE_API_URL", "https://intranet.test/user/role");
    answer({ role: "Alumni", name: "Persona", initials: null });
    freshUser = {
      id: "u2",
      email: "persona@creup.es",
      roleId: "role-cea",
      memberId: "m1",
      externalRole: "CEA",
      externalName: "Persona",
      externalInitials: "VPU",
      university: null,
      role: { name: SYSTEM_ROLES.CEA },
    };

    expect(await syncUserRole("u2")).toBe("ok");
    expect(auditCall(AUDIT_ACTIONS.USER_INITIAL_ADMIN)).toBeUndefined();
    expect(auditCall(AUDIT_ACTIONS.USER_ROLE_SYNC)).toMatchObject({
      targetId: "u2",
      before: {
        roleName: SYSTEM_ROLES.CEA,
        externalRole: "CEA",
        externalInitials: "VPU",
        memberId: "m1",
      },
      after: {
        roleName: SYSTEM_ROLES.INVITADO,
        externalRole: "Alumni",
        externalName: "Persona",
        externalInitials: null,
        university: null,
        memberId: null,
      },
    });
  });

  it("reports a failed call and leaves the account as it was", async () => {
    vi.stubEnv("NUXT_ROLE_API_URL", "https://intranet.test/user/role");
    answer({ error: "boom" }, 500);
    // Nothing to write: not even lastRoleSyncAt.
    freshUser = {
      id: "u3",
      email: "persona@creup.es",
      roleId: "role-asociado",
      memberId: "m2",
      externalRole: "Asociado",
      externalName: "Consejo",
      externalInitials: "CEUM",
      university: "Universidad de Murcia",
      role: { name: SYSTEM_ROLES.ASOCIADO },
    };

    expect(await syncUserRole("u3")).toBe("failed");
    expect(updates).toEqual([]);
    // recordAudit skips it: before and after are equal.
    const sync = auditCall(AUDIT_ACTIONS.USER_ROLE_SYNC);
    expect(sync?.after).toEqual(sync?.before);
  });
});

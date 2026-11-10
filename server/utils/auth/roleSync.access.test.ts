import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

// The access gate and role sync against a stubbed database, with the real
// intranet client (lookupIntranetRole) answering through a stubbed fetch:
// what each intranet answer does to the account and what it records.

interface Account {
  id: string;
  email: string;
  roleId: string | null;
  role: { name: string } | null;
  memberId: string | null;
  intranetId: number | null;
  externalRole: string | null;
  externalName: string | null;
  externalInitials: string | null;
  university: string | null;
  accessRevokedAt: Date | null;
  accessRevokedReason: string | null;
}

const state = vi.hoisted(() => ({
  account: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  sessions: [] as string[],
  roleRow: { id: "role-invitado" } as { id: string } | undefined,
}));

const tx = vi.hoisted(() => {
  const read = async () => (state.account ? { ...state.account } : undefined);
  return {
    execute: async () => undefined,
    query: {
      users: { findFirst: read },
      roles: { findFirst: async () => state.roleRow },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
          if (state.account) Object.assign(state.account, values);
        },
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          const rows = state.sessions.map((id) => ({ id }));
          state.sessions = [];
          return rows;
        },
      }),
    }),
  };
});

vi.mock("../../db", () => ({
  db: {
    query: { users: { findFirst: tx.query.users.findFirst } },
    transaction: async (run: (inner: typeof tx) => Promise<unknown>) => run(tx),
  },
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => "audit-id"));
vi.mock("../domain/audit", () => ({ recordAudit }));
const logger = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../core/logger", () => logger);
const endImpersonations = vi.hoisted(() =>
  vi.fn(async (): Promise<{ id: string }[]> => []),
);
vi.mock("./impersonation", () => ({ endImpersonations }));
const linkUserToIntranetMember = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => null),
);
vi.mock("../members/link", () => ({
  INTRANET_MEMBER_TYPES: new Map([
    ["Asociado", "asociado"],
    ["Sectorial", "sectorial"],
    ["CEA", "executive"],
  ]),
  linkUserToIntranetMember,
}));

const {
  applyIntranetNotFound,
  checkSignInAccess,
  decideIntranetNotFound,
  knownToIntranet,
  restoreIntranetAccess,
  roleSyncOutcome,
  syncUserRole,
} = await import("./roleSync");

const EMAIL = "cdeub@ub.edu";
const ROLE_URL = "https://intranet.test/api/asambleas/v1/user/role";
const NOT_FOUND = { error: "not_found" };
const ASOCIADO_ANSWER = {
  id: 412,
  role: "Asociado",
  name: "Consell de l'Estudiantat UB",
  initials: "CdEUB",
  university: "Universitat de Barcelona",
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "u1",
    email: EMAIL,
    roleId: "role-asociado",
    role: { name: SYSTEM_ROLES.ASOCIADO },
    memberId: "m-cdeub",
    intranetId: null,
    externalRole: "Asociado",
    externalName: "Consell",
    externalInitials: "CdEUB",
    university: "Universitat de Barcelona",
    accessRevokedAt: null,
    accessRevokedReason: null,
    ...overrides,
  };
}

function answer(body: unknown, status = 200, contentType = "application/json") {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": contentType },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function unreachable() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );
}

const audits = () =>
  (
    recordAudit.mock.calls as unknown as [unknown, Record<string, unknown>][]
  ).map(([, input]) => input);
const auditOf = (action: string) =>
  audits().find((input) => input.action === action);

/** Every value the logger received, flattened to text. */
const loggedText = () =>
  JSON.stringify([
    ...logger.logInfo.mock.calls,
    ...logger.logWarn.mock.calls,
    ...logger.logError.mock.calls,
  ]);

beforeEach(() => {
  state.account = account() as unknown as Record<string, unknown>;
  state.updates = [];
  state.sessions = ["s1", "s2"];
  state.roleRow = { id: "role-invitado" };
  recordAudit.mockClear();
  endImpersonations.mockReset();
  endImpersonations.mockResolvedValue([]);
  linkUserToIntranetMember.mockClear();
  logger.logInfo.mockClear();
  logger.logWarn.mockClear();
  logger.logError.mockClear();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NUXT_ROLE_API_URL", ROLE_URL);
  vi.stubEnv("NUXT_INTRANET_API_URL", "");
  vi.stubEnv("NUXT_INTRANET_API_TOKEN", "asm_test_token");
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  vi.stubEnv("APP_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("INITIAL_ADMIN_EMAIL", "tic@creup.es");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pure rules", () => {
  it("knows an account by its stored type or intranet id", () => {
    expect(
      knownToIntranet({ externalRole: "Asociado", intranetId: null }),
    ).toBe(true);
    expect(knownToIntranet({ externalRole: null, intranetId: 7 })).toBe(true);
    expect(knownToIntranet({ externalRole: null, intranetId: null })).toBe(
      false,
    );
  });

  it("revokes only a known account without a protected role", () => {
    const base = {
      accessRevokedAt: null,
      externalRole: "Asociado",
      intranetId: null,
      roleName: SYSTEM_ROLES.ASOCIADO,
    };
    expect(decideIntranetNotFound(base)).toBe("revoke");
    expect(
      decideIntranetNotFound({ ...base, accessRevokedAt: new Date() }),
    ).toBe("already_revoked");
    expect(decideIntranetNotFound({ ...base, externalRole: null })).toBe(
      "unknown",
    );
    for (const roleName of [
      SYSTEM_ROLES.ADMIN,
      SYSTEM_ROLES.SECRETARIA,
      SYSTEM_ROLES.PRESIDENCIA,
      SYSTEM_ROLES.MODERADOR,
    ]) {
      expect(decideIntranetNotFound({ ...base, roleName })).toBe("protected");
    }
    expect(
      decideIntranetNotFound({ ...base, roleName: SYSTEM_ROLES.CEA }),
    ).toBe("revoke");
  });

  it("names the sign-in outcome of every lookup", () => {
    expect(roleSyncOutcome({ outcome: "notFound" })).toBe("not_found");
    expect(
      roleSyncOutcome({ outcome: "failed", reason: "status", status: 500 }),
    ).toBe("failed");
    expect(roleSyncOutcome({ outcome: "unconfigured" })).toBe("unconfigured");
  });
});

describe("an account deleted in the intranet", () => {
  it("loses access, its sessions, member, role and impersonations, all recorded", async () => {
    const fetchMock = answer(NOT_FOUND, 404);
    endImpersonations.mockResolvedValue([{ id: "imp1" }]);

    expect(await checkSignInAccess("u1")).toEqual({ allowed: false });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
    expect(state.updates).toEqual([
      {
        accessRevokedAt: expect.any(Date),
        accessRevokedReason: "intranet_deleted",
        memberId: null,
        roleId: "role-invitado",
      },
    ]);
    expect(state.sessions).toEqual([]);
    expect(endImpersonations).toHaveBeenCalledWith(
      tx,
      { userId: "u1" },
      "revoked",
    );
    expect(audits()).toEqual([
      {
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.USER_ACCESS_REVOKED,
        targetType: "user",
        targetId: "u1",
        before: {
          roleName: SYSTEM_ROLES.ASOCIADO,
          memberId: "m-cdeub",
          accessRevokedReason: null,
        },
        after: {
          roleName: SYSTEM_ROLES.OTRO,
          memberId: null,
          accessRevokedReason: "intranet_deleted",
          sessionsEnded: 2,
          impersonationsEnded: 1,
        },
      },
    ]);
    // Correlated by fingerprint, never by email.
    expect(loggedText()).not.toContain(EMAIL);
    expect(logger.logWarn).toHaveBeenCalledWith(
      "roleSync.access",
      expect.objectContaining({
        action: "access revoked",
        accountRef: expect.stringMatching(/^[0-9a-f]{12}$/),
      }),
    );
  });

  it("is revoked once: a second answer changes and records nothing", async () => {
    answer(NOT_FOUND, 404);
    expect((await applyIntranetNotFound("u1")).kind).toBe("revoked");
    state.updates = [];
    recordAudit.mockClear();

    expect(await applyIntranetNotFound("u1")).toEqual({
      kind: "already_revoked",
    });
    expect(state.updates).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("is revoked by role sync too when no gate asked before", async () => {
    answer(NOT_FOUND, 404);
    expect(await syncUserRole("u1")).toBe("not_found");
    expect(auditOf(AUDIT_ACTIONS.USER_ACCESS_REVOKED)).toBeDefined();
    expect(auditOf(AUDIT_ACTIONS.USER_ROLE_SYNC)).toBeUndefined();
    expect(linkUserToIntranetMember).not.toHaveBeenCalled();
  });

  it("leaves no role when the Otro row is missing", async () => {
    answer(NOT_FOUND, 404);
    state.roleRow = undefined;
    await applyIntranetNotFound("u1");
    expect(state.updates[0]).toMatchObject({ roleId: null });
    expect(auditOf(AUDIT_ACTIONS.USER_ACCESS_REVOKED)?.after).toMatchObject({
      roleName: null,
    });
  });
});

describe("a not_found answer that revokes nothing", () => {
  it("keeps today's behaviour for a Google account the intranet never knew", async () => {
    answer(NOT_FOUND, 404);
    state.account = account({
      roleId: null,
      role: null,
      memberId: null,
      externalRole: null,
      externalName: null,
      externalInitials: null,
      university: null,
    }) as unknown as Record<string, unknown>;

    const access = await checkSignInAccess("u1");
    expect(access).toEqual({ allowed: true, lookup: { outcome: "notFound" } });
    expect(state.updates).toEqual([]);
    expect(state.sessions).toEqual(["s1", "s2"]);

    // The new account becomes Otro; no intranet data, no lastRoleSyncAt.
    const lookup = access.allowed ? (access.lookup ?? undefined) : undefined;
    expect(await syncUserRole("u1", { lookup })).toBe("not_found");
    expect(state.updates).toEqual([{ roleId: "role-invitado" }]);
  });

  it("keeps a protected role and records that the intranet lost it", async () => {
    answer(NOT_FOUND, 404);
    state.account = account({
      roleId: "role-secretaria",
      role: { name: SYSTEM_ROLES.SECRETARIA },
      memberId: null,
      externalRole: "CEA",
    }) as unknown as Record<string, unknown>;

    expect(await checkSignInAccess("u1")).toMatchObject({ allowed: true });
    expect(state.updates).toEqual([]);
    expect(state.sessions).toEqual(["s1", "s2"]);
    expect(endImpersonations).not.toHaveBeenCalled();
    expect(audits()).toEqual([
      {
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.USER_INTRANET_MISSING,
        targetType: "user",
        targetId: "u1",
        after: { roleName: SYSTEM_ROLES.SECRETARIA },
      },
    ]);
    expect(logger.logWarn).toHaveBeenCalledWith(
      "roleSync.access",
      expect.objectContaining({ roleName: SYSTEM_ROLES.SECRETARIA }),
    );
  });
});

describe("intranet failures never revoke", () => {
  const cases: [string, () => void][] = [
    ["a 500", () => answer({ message: "Server Error" }, 500)],
    ["a timeout or network error", () => unreachable()],
    [
      "the legacy 404 body",
      () => answer({ error: "Usuario no encontrado" }, 404),
    ],
    ["a route-not-found 404", () => answer({ message: "Not Found." }, 404)],
    ["an HTML 404", () => answer("<html>Not Found</html>", 404, "text/html")],
    [
      "not_found with more keys",
      () => answer({ error: "not_found", detail: "x" }, 404),
    ],
  ];

  it.each(cases)("%s keeps the account as it was", async (_, setup) => {
    setup();
    const access = await checkSignInAccess("u1");
    expect(access).toMatchObject({
      allowed: true,
      lookup: { outcome: "failed" },
    });
    expect(state.updates).toEqual([]);
    expect(state.sessions).toEqual(["s1", "s2"]);
    expect(recordAudit).not.toHaveBeenCalled();

    // Role sync then writes nothing at all, lastRoleSyncAt included.
    const lookup = access.allowed ? (access.lookup ?? undefined) : undefined;
    expect(await syncUserRole("u1", { lookup })).toBe("failed");
    expect(state.updates).toEqual([]);
    expect(linkUserToIntranetMember).not.toHaveBeenCalled();
  });

  it("an unauthenticated not_found is a failure", async () => {
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "");
    answer(NOT_FOUND, 404);
    expect(await checkSignInAccess("u1")).toMatchObject({
      allowed: true,
      lookup: { outcome: "failed", status: 404 },
    });
    expect(state.updates).toEqual([]);
  });

  it("an unconfigured intranet lets everyone with access in", async () => {
    vi.stubEnv("NUXT_ROLE_API_URL", "");
    expect(await checkSignInAccess("u1")).toEqual({
      allowed: true,
      lookup: { outcome: "unconfigured" },
    });
  });
});

describe("signing in again after losing access", () => {
  beforeEach(() => {
    state.account = account({
      roleId: "role-invitado",
      role: { name: SYSTEM_ROLES.OTRO },
      memberId: null,
      accessRevokedAt: new Date("2026-10-01T10:00:00Z"),
      accessRevokedReason: "intranet_deleted",
    }) as unknown as Record<string, unknown>;
  });

  it("restores access when the intranet knows the account again", async () => {
    answer(ASOCIADO_ANSWER);
    const access = await checkSignInAccess("u1");
    expect(access).toMatchObject({ allowed: true, lookup: { outcome: "ok" } });
    expect(state.updates).toEqual([
      { accessRevokedAt: null, accessRevokedReason: null },
    ]);
    expect(audits()).toEqual([
      {
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.USER_ACCESS_RESTORED,
        targetType: "user",
        targetId: "u1",
        before: { accessRevokedReason: "intranet_deleted" },
        after: { accessRevokedReason: null },
      },
    ]);

    // The normal role sync follows with the same answer, asked once.
    state.updates = [];
    state.roleRow = { id: "role-asociado" };
    const lookup = access.allowed ? (access.lookup ?? undefined) : undefined;
    expect(await syncUserRole("u1", { lookup })).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.updates[0]).toMatchObject({
      roleId: "role-asociado",
      intranetId: 412,
      externalRole: "Asociado",
      lastRoleSyncAt: expect.any(Date),
    });
    expect(linkUserToIntranetMember).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: 412, initials: "CdEUB" }),
      { previousInitials: "CdEUB" },
    );
  });

  it.each([
    ["still not_found", () => answer(NOT_FOUND, 404)],
    ["unreachable", () => unreachable()],
    ["a 500", () => answer({ message: "Server Error" }, 500)],
  ])("refuses it when the intranet answers %s", async (_, setup) => {
    setup();
    expect(await checkSignInAccess("u1")).toEqual({ allowed: false });
    expect(state.updates).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses it when the lookup that found it was not authenticated", async () => {
    vi.stubEnv("NUXT_INTRANET_API_TOKEN", "");
    answer(ASOCIADO_ANSWER);
    expect(await checkSignInAccess("u1")).toEqual({ allowed: false });
    expect(state.updates).toEqual([]);
  });

  it("restores nothing for an account that has access", async () => {
    state.account = account() as unknown as Record<string, unknown>;
    expect(await restoreIntranetAccess("u1")).toBe(false);
    expect(state.updates).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("role sync alone never gives a revoked account its role back", async () => {
    answer(ASOCIADO_ANSWER);
    expect(await syncUserRole("u1")).toBe("ok");
    expect(state.updates).toEqual([]);
    expect(linkUserToIntranetMember).not.toHaveBeenCalled();
  });
});

describe("lastRoleSyncAt and the intranet id", () => {
  it("are written only by a successful lookup", async () => {
    answer(ASOCIADO_ANSWER);
    expect(await syncUserRole("u1")).toBe("ok");
    expect(state.updates).toEqual([
      expect.objectContaining({
        lastRoleSyncAt: expect.any(Date),
        intranetId: 412,
      }),
    ]);
    expect(auditOf(AUDIT_ACTIONS.USER_ROLE_SYNC)).toMatchObject({
      before: { intranetId: null },
      after: { intranetId: 412 },
    });
  });

  it("keeps a stored id when the answer has none (legacy route)", async () => {
    state.account = account({ intranetId: 412 }) as unknown as Record<
      string,
      unknown
    >;
    const { id: _id, ...legacy } = ASOCIADO_ANSWER;
    answer(legacy);
    await syncUserRole("u1");
    expect(state.updates[0]).not.toHaveProperty("intranetId");
    expect(state.updates[0]).toHaveProperty("lastRoleSyncAt");
  });
});

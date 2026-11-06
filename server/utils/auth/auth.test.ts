import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";

// The better-auth instance is stubbed: only the traceability hooks are
// tested, with the writers they call.
const recordAudit = vi.fn(async () => "audit-id");
const endImpersonations = vi.fn(async () => []);
const syncUserRole = vi.fn(async (..._args: unknown[]) => "ok");
const checkSignInAccess = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    allowed: true,
    lookup: null,
  }),
);
const tx = { tx: true };
const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
  run(tx),
);

vi.mock("better-auth", () => ({
  betterAuth: (options: unknown) => ({ options, $Infer: {} }),
}));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: vi.fn() }));
vi.mock("../../db", () => ({ db: { transaction } }));
vi.mock("../domain/audit", () => ({ recordAudit }));
vi.mock("./impersonation", () => ({ endImpersonations }));
vi.mock("./roleSync", () => ({ checkSignInAccess, syncUserRole }));
vi.mock("../core/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.stubEnv("APP_SECRET", "test-secret-test-secret-test-secret");
vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");

const {
  auth,
  classifySessionEnd,
  hookClientInfo,
  recordSessionEnd,
  recordSignIn,
  recordUserCreated,
  SIGN_IN_ERROR_CODES,
  SIGN_IN_ERROR_URL,
} = await import("./auth");
const { db } = await import("../../db");

interface Hooks {
  user: { create: { after: (user: unknown, ctx: unknown) => Promise<void> } };
  session: {
    create: {
      before: (session: unknown, ctx: unknown) => Promise<unknown>;
      after: (session: unknown, ctx: unknown) => Promise<void>;
    };
    delete: { after: (session: unknown, ctx: unknown) => Promise<void> };
  };
}
const options = (
  auth as unknown as {
    options: {
      databaseHooks: Hooks;
      onAPIError?: { errorURL?: string };
    };
  }
).options;
const hooks = options.databaseHooks;

const now = new Date("2026-11-05T12:00:00Z");
const later = new Date("2026-11-12T12:00:00Z");
const earlier = new Date("2026-11-05T11:00:00Z");

function context(path: string, headers: Record<string, string> = {}) {
  return { path, headers: new Headers(headers) };
}

beforeEach(() => {
  recordAudit.mockClear();
  endImpersonations.mockClear();
  syncUserRole.mockClear();
  checkSignInAccess.mockClear();
  transaction.mockClear();
});

describe("hookClientInfo", () => {
  it("takes the first forwarded address and the user agent", () => {
    expect(
      hookClientInfo(
        context("/sign-out", {
          "x-forwarded-for": "203.0.113.9, 10.0.0.1",
          "user-agent": "Firefox",
        }),
      ),
    ).toEqual({ ipAddress: "203.0.113.9", userAgent: "Firefox" });
    expect(
      hookClientInfo({
        request: { headers: new Headers({ "x-real-ip": "198.51.100.2" }) },
      }),
    ).toEqual({ ipAddress: "198.51.100.2", userAgent: null });
    expect(hookClientInfo(null)).toEqual({ ipAddress: null, userAgent: null });
  });
});

describe("classifySessionEnd", () => {
  it("calls only the sign-out endpoint a sign-out", () => {
    expect(
      classifySessionEnd({ expiresAt: later }, context("/sign-out"), now),
    ).toMatchObject({
      action: AUDIT_ACTIONS.AUTH_SIGN_OUT,
      reason: "signed_out",
      impersonationEnd: "signed_out",
      byRequest: true,
    });
  });

  it("tells an expired session, deleted inside get-session, from a revoked one", () => {
    expect(
      classifySessionEnd({ expiresAt: earlier }, context("/get-session"), now),
    ).toMatchObject({
      action: AUDIT_ACTIONS.AUTH_SESSION_ENDED,
      reason: "expired",
      impersonationEnd: "expired",
      byRequest: false,
    });
    expect(
      classifySessionEnd({ expiresAt: later }, context("/revoke-session"), now),
    ).toMatchObject({
      action: AUDIT_ACTIONS.AUTH_SESSION_ENDED,
      reason: "revoked",
      impersonationEnd: "signed_out",
    });
    expect(
      classifySessionEnd({ expiresAt: earlier.toISOString() }, null, now),
    ).toMatchObject({ reason: "expired" });
  });
});

describe("recordSessionEnd", () => {
  const session = { id: "s1", userId: "u1", expiresAt: later };

  it("ends the session's impersonations and records the sign-out together", async () => {
    await recordSessionEnd(
      session,
      context("/sign-out", { "x-forwarded-for": "203.0.113.9" }),
      now,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(endImpersonations).toHaveBeenCalledWith(
      tx,
      { sessionId: "s1" },
      "signed_out",
      { ipAddress: "203.0.113.9", userAgent: null },
    );
    expect(recordAudit).toHaveBeenCalledWith(tx, {
      actor: { userId: "u1" },
      source: "auth",
      action: AUDIT_ACTIONS.AUTH_SIGN_OUT,
      targetType: "user",
      targetId: "u1",
      after: { sessionId: "s1", reason: "signed_out" },
      ipAddress: "203.0.113.9",
      userAgent: null,
    });
  });

  it("keeps no client for a session that expired on its own", async () => {
    await recordSessionEnd(
      { ...session, expiresAt: earlier },
      context("/get-session", { "x-forwarded-for": "203.0.113.9" }),
      now,
    );
    expect(endImpersonations).toHaveBeenCalledWith(
      tx,
      { sessionId: "s1" },
      "expired",
      { ipAddress: null, userAgent: null },
    );
    expect(recordAudit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: AUDIT_ACTIONS.AUTH_SESSION_ENDED,
        after: { sessionId: "s1", reason: "expired" },
        ipAddress: null,
      }),
    );
  });
});

describe("recordSignIn and recordUserCreated", () => {
  it("record the sign-in with the session's client and the sync outcome", async () => {
    await recordSignIn(
      { id: "s1", userId: "u1", ipAddress: "192.0.2.1", userAgent: "Edge" },
      "unconfigured",
    );
    expect(recordAudit).toHaveBeenCalledWith(db, {
      actor: { userId: "u1" },
      source: "auth",
      action: AUDIT_ACTIONS.AUTH_SIGN_IN,
      targetType: "user",
      targetId: "u1",
      after: { sessionId: "s1", roleSync: "unconfigured" },
      ipAddress: "192.0.2.1",
      userAgent: "Edge",
    });
  });

  it("record the account creation by the user, without the email", async () => {
    await recordUserCreated(
      { id: "u1", name: "Persona" },
      context("/callback/google", { "user-agent": "Safari" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(db, {
      actor: { userId: "u1" },
      source: "auth",
      action: AUDIT_ACTIONS.USER_CREATED,
      targetType: "user",
      targetId: "u1",
      after: { name: "Persona" },
      ipAddress: null,
      userAgent: "Safari",
    });
  });
});

describe("the sign-in access gate", () => {
  const lookup = {
    outcome: "ok",
    account: {
      id: 412,
      role: "Asociado",
      name: null,
      initials: "CdEUB",
      university: null,
    },
  };

  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).not.toBeNull();
    return error as {
      statusCode?: number;
      status?: string;
      body?: { code?: string };
    };
  }

  it("refuses an account without access with a code the login page knows", async () => {
    checkSignInAccess.mockResolvedValueOnce({ allowed: false });
    const error = await refusal(
      hooks.session.create.before({ userId: "u1", token: "t1" }, null),
    );
    expect(checkSignInAccess).toHaveBeenCalledWith("u1");
    expect(error.body?.code).toBe(SIGN_IN_ERROR_CODES.accessRevoked);
    expect(error.statusCode).toBe(403);
  });

  it("refuses rather than letting a deleted account in when the check breaks", async () => {
    checkSignInAccess.mockRejectedValueOnce(new Error("db down"));
    const error = await refusal(
      hooks.session.create.before({ userId: "u1", token: "t1" }, null),
    );
    expect(error.body?.code).toBe(SIGN_IN_ERROR_CODES.unavailable);
  });

  it("hands the lookup to role sync, so the intranet is asked once", async () => {
    checkSignInAccess.mockResolvedValueOnce({ allowed: true, lookup });
    await expect(
      hooks.session.create.before({ userId: "u1", token: "t-ok" }, null),
    ).resolves.toBeUndefined();
    await hooks.session.create.after(
      { id: "s1", userId: "u1", token: "t-ok" },
      null,
    );
    expect(syncUserRole).toHaveBeenCalledWith("u1", { lookup });

    // Taken once: another session of the same token asks again.
    syncUserRole.mockClear();
    await hooks.session.create.after(
      { id: "s2", userId: "u1", token: "t-ok" },
      null,
    );
    expect(syncUserRole).toHaveBeenCalledWith("u1", {});
  });

  it("sends failed sign-ins to the login page, which maps every code", () => {
    expect(options.onAPIError?.errorURL).toBe(SIGN_IN_ERROR_URL);
    expect(SIGN_IN_ERROR_URL).toBe("/login");
    const page = readFileSync(
      new URL("../../../app/pages/login.vue", import.meta.url),
      "utf8",
    );
    for (const code of Object.values(SIGN_IN_ERROR_CODES)) {
      expect(page).toContain(`${code}:`);
    }
  });
});

describe("databaseHooks", () => {
  it("records the sign-in after role sync, even when the sync throws", async () => {
    syncUserRole.mockRejectedValueOnce(new Error("intranet down"));
    await hooks.session.create.after({ id: "s1", userId: "u1" }, null);
    expect(syncUserRole).toHaveBeenCalledWith("u1", {});
    expect(recordAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: AUDIT_ACTIONS.AUTH_SIGN_IN,
        after: { sessionId: "s1", roleSync: "failed" },
      }),
    );
  });

  it("never lets an audit failure block signing in, up or out", async () => {
    recordAudit.mockRejectedValue(new Error("db down"));
    await expect(
      hooks.session.create.after({ id: "s1", userId: "u1" }, null),
    ).resolves.toBeUndefined();
    await expect(
      hooks.user.create.after({ id: "u1", name: "Persona" }, null),
    ).resolves.toBeUndefined();
    await expect(
      hooks.session.delete.after(
        { id: "s1", userId: "u1", expiresAt: later },
        context("/sign-out"),
      ),
    ).resolves.toBeUndefined();
    recordAudit.mockReset();
    recordAudit.mockResolvedValue("audit-id");
  });
});

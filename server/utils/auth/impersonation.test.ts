import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, type H3Event } from "h3";
import {
  ACTING_USER_HEADER_NAME,
  IMPERSONATION_TTL_MINUTES,
} from "~~/shared/constants/security";

// Pure rules plus the request flow with a scripted database; recordAudit is
// checked through its calls.
const dbState = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  updateRows: [] as unknown[],
  selects: 0,
  updates: [] as { set: Record<string, unknown> }[],
  /** What the start transaction's FOR SHARE read of the target returns. */
  lockRows: [] as unknown[],
  inserts: [] as Record<string, unknown>[],
}));

vi.mock("../../db", () => {
  const selectChain = {
    from: () => selectChain,
    leftJoin: () => selectChain,
    where: () => selectChain,
    limit: async () => dbState.selectRows,
  };
  const lockChain = {
    from: () => lockChain,
    where: () => lockChain,
    for: async () => dbState.lockRows,
  };
  const tx = {
    select: () => lockChain,
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          dbState.inserts.push(values);
          return [{ id: "imp-new", endedAt: null, endReason: null, ...values }];
        },
      }),
    }),
  };
  return {
    db: {
      transaction: async (run: (inner: typeof tx) => Promise<unknown>) =>
        run(tx),
      select: () => {
        dbState.selects += 1;
        return selectChain;
      },
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              dbState.updates.push({ set });
              return dbState.updateRows;
            },
          }),
        }),
      }),
    },
  };
});

const recordAudit = vi.hoisted(() => vi.fn(async () => "audit-id"));
vi.mock("../domain/audit", () => ({
  recordAudit,
  requestClientInfo: () => ({ ipAddress: null, userAgent: null }),
}));

const {
  actingUserConflict,
  assertActingUser,
  assertNotImpersonatingMutation,
  decideImpersonation,
  endImpersonations,
  IMPERSONATION_START_ERRORS,
  impersonationExpiry,
  impersonationIsActive,
  impersonationStartBlocker,
  resolveImpersonation,
  startImpersonation,
  stopImpersonation,
  toImpersonationDto,
} = await import("./impersonation");

const NOW = new Date("2026-11-05T10:00:00.000Z");
const LATER = new Date("2026-11-05T10:30:00.000Z");
const EARLIER = new Date("2026-11-05T09:30:00.000Z");

function fakeEvent(
  method: string,
  headers: Record<string, string> = {},
  context: Record<string, unknown> = {},
): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = "/api/test";
  req.headers = headers;
  const event = createEvent(req, new ServerResponse(req));
  Object.assign(event.context, context);
  return event;
}

function user(id: string, roleName: string | null) {
  return {
    id,
    name: `name-${id}`,
    email: `${id}@creup.es`,
    image: null,
    roleId: roleName ? `role-${roleName}` : null,
    externalRole: null,
    externalName: null,
    externalInitials: null,
    university: null,
    memberId: roleName === "Asociado" ? "member-1" : null,
    lastRoleSyncAt: null,
    role: roleName ? { id: `role-${roleName}`, name: roleName } : null,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "imp1",
    adminUserId: "admin",
    targetUserId: "target",
    sessionId: "session-1",
    reason: "Revisar su borrador",
    startedAt: EARLIER,
    expiresAt: LATER,
    endedAt: null,
    endReason: null,
    ...overrides,
  };
}

describe("decideImpersonation", () => {
  const base = {
    realUserId: "admin",
    realRoleName: "Admin",
    row: { endedAt: null, expiresAt: LATER, targetUserId: "target" },
    target: { id: "target", roleName: "Asociado" },
    now: NOW,
  };

  it("applies an open, unexpired row on a non-Admin target", () => {
    expect(decideImpersonation(base)).toEqual({ kind: "apply" });
  });

  it("does nothing without an open row", () => {
    expect(decideImpersonation({ ...base, row: null })).toEqual({
      kind: "none",
    });
    expect(
      decideImpersonation({
        ...base,
        row: { ...base.row, endedAt: EARLIER },
      }),
    ).toEqual({ kind: "none" });
  });

  it("closes an expired row, also exactly at the expiry", () => {
    expect(
      decideImpersonation({ ...base, row: { ...base.row, expiresAt: NOW } }),
    ).toEqual({ kind: "close", reason: "expired" });
  });

  it("revokes when the signed-in user is no longer Admin", () => {
    expect(
      decideImpersonation({ ...base, realRoleName: "Secretaria" }),
    ).toEqual({ kind: "close", reason: "revoked" });
  });

  it("revokes when the target became Admin, vanished or is the Admin", () => {
    for (const target of [
      { id: "target", roleName: "Admin" },
      null,
      { id: "other", roleName: "Asociado" },
    ]) {
      expect(decideImpersonation({ ...base, target })).toEqual({
        kind: "close",
        reason: "revoked",
      });
    }
    expect(
      decideImpersonation({
        ...base,
        row: { ...base.row, targetUserId: "admin" },
        target: { id: "admin", roleName: "Asociado" },
      }),
    ).toEqual({ kind: "close", reason: "revoked" });
  });

  it("revokes when the target lost access to the platform", () => {
    expect(
      decideImpersonation({
        ...base,
        target: { id: "target", roleName: "Invitado", accessRevoked: true },
      }),
    ).toEqual({ kind: "close", reason: "revoked" });
    expect(
      decideImpersonation({
        ...base,
        target: { id: "target", roleName: "Invitado", accessRevoked: false },
      }),
    ).toEqual({ kind: "apply" });
  });

  it("prefers expired over revoked when both hold", () => {
    expect(
      decideImpersonation({
        ...base,
        row: { ...base.row, expiresAt: EARLIER },
        target: null,
      }),
    ).toEqual({ kind: "close", reason: "expired" });
  });
});

describe("impersonationStartBlocker", () => {
  const base = {
    realUserId: "admin",
    realRoleName: "Admin",
    impersonating: false,
    target: { id: "target", roleName: "Asociado" },
  };

  it("lets a real Admin act as anyone else who is not Admin", () => {
    expect(impersonationStartBlocker(base)).toBeNull();
    for (const roleName of ["Secretaria", "Presidencia", "Moderador", null]) {
      expect(
        impersonationStartBlocker({
          ...base,
          target: { id: "target", roleName },
        }),
      ).toBeNull();
    }
  });

  it("refuses everyone but Admins, whatever they hold", () => {
    for (const realRoleName of ["Secretaria", "Presidencia", null]) {
      expect(impersonationStartBlocker({ ...base, realRoleName })).toBe(
        "admin_only",
      );
    }
  });

  it("refuses nesting, missing targets, oneself and other Admins", () => {
    expect(impersonationStartBlocker({ ...base, impersonating: true })).toBe(
      "nested",
    );
    expect(impersonationStartBlocker({ ...base, target: null })).toBe(
      "not_found",
    );
    expect(
      impersonationStartBlocker({
        ...base,
        target: { id: "admin", roleName: "Admin" },
      }),
    ).toBe("self");
    expect(
      impersonationStartBlocker({
        ...base,
        target: { id: "other", roleName: "Admin" },
      }),
    ).toBe("target_admin");
  });

  it("refuses an account that lost access to the platform", () => {
    expect(
      impersonationStartBlocker({
        ...base,
        target: { id: "target", roleName: "Invitado", accessRevoked: true },
      }),
    ).toBe("target_revoked");
    expect(IMPERSONATION_START_ERRORS.target_revoked).toMatchObject({
      statusCode: 403,
      messageKey: "impersonation.errors.targetRevoked",
    });
  });

  it("maps every blocker to its status and i18n key", () => {
    expect(IMPERSONATION_START_ERRORS.nested.statusCode).toBe(409);
    expect(IMPERSONATION_START_ERRORS.self.statusCode).toBe(422);
    expect(IMPERSONATION_START_ERRORS.target_admin.statusCode).toBe(403);
    expect(IMPERSONATION_START_ERRORS.admin_only.statusCode).toBe(403);
    for (const error of Object.values(IMPERSONATION_START_ERRORS)) {
      expect(error.messageKey).toMatch(/^impersonation\.errors\./);
    }
  });
});

describe("impersonationExpiry", () => {
  it("ends after the fixed time limit", () => {
    expect(impersonationExpiry(NOW, null).getTime()).toBe(
      NOW.getTime() + IMPERSONATION_TTL_MINUTES * 60_000,
    );
  });

  it("never outlives the Admin's own session", () => {
    const sessionEnd = new Date(NOW.getTime() + 10 * 60_000);
    expect(impersonationExpiry(NOW, sessionEnd)).toEqual(sessionEnd);
    const farSession = new Date(NOW.getTime() + 24 * 3600_000);
    expect(impersonationExpiry(NOW, farSession).getTime()).toBe(
      NOW.getTime() + IMPERSONATION_TTL_MINUTES * 60_000,
    );
  });
});

describe("actingUserConflict", () => {
  it("never checks safe methods", () => {
    expect(
      actingUserConflict({
        method: "GET",
        realIsAdmin: true,
        effectiveUserId: "target",
        header: null,
      }),
    ).toBe(false);
  });

  it("requires the header to name the effective user when the real user is Admin", () => {
    const base = { method: "POST", realIsAdmin: true, effectiveUserId: "t" };
    expect(actingUserConflict({ ...base, header: "t" })).toBe(false);
    expect(actingUserConflict({ ...base, header: " t " })).toBe(false);
    expect(actingUserConflict({ ...base, header: undefined })).toBe(true);
    expect(actingUserConflict({ ...base, header: "admin" })).toBe(true);
  });

  it("only checks a header that is present for everyone else", () => {
    const base = { method: "put", realIsAdmin: false, effectiveUserId: "u" };
    expect(actingUserConflict({ ...base, header: null })).toBe(false);
    expect(actingUserConflict({ ...base, header: "u" })).toBe(false);
    expect(actingUserConflict({ ...base, header: "other" })).toBe(true);
  });
});

describe("request guards", () => {
  const admin = user("admin", "Admin");
  const target = user("target", "Asociado");
  const impersonating = {
    realUser: admin,
    user: target,
    impersonation: { id: "imp1" },
  };

  it("answers 409 identityChanged on a stale acting user", () => {
    const event = fakeEvent(
      "POST",
      { [ACTING_USER_HEADER_NAME]: "admin" },
      impersonating,
    );
    expect(() => assertActingUser(event)).toThrowError(
      expect.objectContaining({
        statusCode: 409,
        data: { messageKey: "auth.identityChanged" },
      }),
    );
    expect(() =>
      assertActingUser(
        fakeEvent(
          "POST",
          { [ACTING_USER_HEADER_NAME]: "target" },
          impersonating,
        ),
      ),
    ).not.toThrow();
  });

  it("keeps the admin section read-only while impersonating", () => {
    expect(() =>
      assertNotImpersonatingMutation(fakeEvent("PUT", {}, impersonating)),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        data: { messageKey: "admin.impersonationReadOnly" },
      }),
    );
    expect(() =>
      assertNotImpersonatingMutation(fakeEvent("GET", {}, impersonating)),
    ).not.toThrow();
    expect(() =>
      assertNotImpersonatingMutation(
        fakeEvent("PUT", {}, { realUser: admin, user: admin }),
      ),
    ).not.toThrow();
  });
});

describe("toImpersonationDto", () => {
  it("serializes dates and computes whether it still applies", () => {
    const dto = toImpersonationDto(
      row(),
      { admin: { id: "admin", name: "Ana" }, target: null },
      NOW,
    );
    expect(dto).toMatchObject({
      id: "imp1",
      admin: { id: "admin", name: "Ana" },
      target: null,
      startedAt: EARLIER.toISOString(),
      expiresAt: LATER.toISOString(),
      endedAt: null,
      endReason: null,
      active: true,
    });
    expect(impersonationIsActive(row({ expiresAt: NOW }), NOW)).toBe(false);
    expect(impersonationIsActive(row({ endedAt: EARLIER }), NOW)).toBe(false);
  });
});

describe("resolveImpersonation", () => {
  const admin = user("admin", "Admin");
  const target = user("target", "Asociado");

  beforeEach(() => {
    dbState.selectRows = [];
    dbState.updateRows = [];
    dbState.selects = 0;
    dbState.updates = [];
    recordAudit.mockClear();
  });

  function found(overrides: Record<string, unknown> = {}, t = target) {
    const { role, ...columns } = t;
    return { row: row(overrides), target: columns, targetRole: role };
  }

  it("costs non-Admins no query", async () => {
    const result = await resolveImpersonation(fakeEvent("GET"), {
      sessionId: "session-1",
      realUser: user("someone", "Secretaria"),
      now: NOW,
    });
    expect(result).toBeNull();
    expect(dbState.selects).toBe(0);
  });

  it("runs the request as the target while the row applies", async () => {
    dbState.selectRows = [found()];
    const result = await resolveImpersonation(fakeEvent("GET"), {
      sessionId: "session-1",
      realUser: admin,
      now: NOW,
    });
    expect(result?.user).toEqual(target);
    expect(result?.impersonation).toMatchObject({
      id: "imp1",
      admin: { id: "admin", name: "name-admin", email: "admin@creup.es" },
      targetUserId: "target",
      expiresAt: LATER,
    });
    expect(dbState.updates).toHaveLength(0);
  });

  it("closes an expired row lazily and runs as the Admin", async () => {
    dbState.selectRows = [found({ expiresAt: EARLIER })];
    dbState.updateRows = [row({ expiresAt: EARLIER, endedAt: EARLIER })];
    const result = await resolveImpersonation(fakeEvent("GET"), {
      sessionId: "session-1",
      realUser: admin,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(dbState.updates[0]?.set.endReason).toBe("expired");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "impersonation.expire",
        source: "system",
        actor: { userId: "admin", impersonationId: "imp1" },
        targetType: "user",
        targetId: "target",
      }),
    );
  });

  it("revokes when the target lost access meanwhile", async () => {
    dbState.selectRows = [
      { ...found(), targetAccessRevokedAt: new Date("2026-11-05T09:45:00Z") },
    ];
    dbState.updateRows = [row({ endedAt: NOW })];
    expect(
      await resolveImpersonation(fakeEvent("GET"), {
        sessionId: "session-1",
        realUser: admin,
        now: NOW,
      }),
    ).toBeNull();
    expect(dbState.updates[0]?.set.endReason).toBe("revoked");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "impersonation.revoke",
        source: "system",
        targetId: "target",
      }),
    );
  });

  it("revokes when the target became Admin", async () => {
    dbState.selectRows = [found({}, user("target", "Admin"))];
    dbState.updateRows = [row({ endedAt: NOW })];
    expect(
      await resolveImpersonation(fakeEvent("GET"), {
        sessionId: "session-1",
        realUser: admin,
        now: NOW,
      }),
    ).toBeNull();
    expect(dbState.updates[0]?.set.endReason).toBe("revoked");
  });
});

describe("startImpersonation and accounts without access", () => {
  const admin = user("admin", "Admin");

  beforeEach(() => {
    dbState.selectRows = [];
    dbState.lockRows = [];
    dbState.inserts = [];
    recordAudit.mockClear();
  });

  function adminEvent() {
    return fakeEvent(
      "POST",
      {},
      {
        realUser: admin,
        user: admin,
        impersonation: null,
        session: {
          session: { id: "session-1", expiresAt: LATER },
          user: { id: "admin" },
        },
      },
    );
  }

  async function startError(): Promise<{
    statusCode?: number;
    data?: { messageKey?: string };
  }> {
    return startImpersonation(adminEvent(), {
      targetUserId: "target",
      reason: "Revisar su borrador",
      now: NOW,
    }).then(
      () => ({}),
      (error: { statusCode?: number; data?: { messageKey?: string } }) => error,
    );
  }

  it("refuses an account that lost access, before writing anything", async () => {
    dbState.selectRows = [
      {
        id: "target",
        name: "Persona",
        externalName: null,
        roleName: "Invitado",
        accessRevokedAt: EARLIER,
      },
    ];
    const error = await startError();
    expect(error.statusCode).toBe(403);
    expect(error.data?.messageKey).toBe("impersonation.errors.targetRevoked");
    expect(dbState.inserts).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses one that lost access between the read and the write", async () => {
    dbState.selectRows = [
      {
        id: "target",
        name: "Persona",
        externalName: null,
        roleName: "Asociado",
        accessRevokedAt: null,
      },
    ];
    dbState.lockRows = [];
    const error = await startError();
    expect(error.data?.messageKey).toBe("impersonation.errors.targetRevoked");
    expect(dbState.inserts).toEqual([]);
  });

  it("starts on an account with access", async () => {
    dbState.selectRows = [
      {
        id: "target",
        name: "Persona",
        externalName: null,
        roleName: "Asociado",
        accessRevokedAt: null,
      },
    ];
    dbState.lockRows = [{ id: "target" }];
    const dto = await startImpersonation(adminEvent(), {
      targetUserId: "target",
      reason: "Revisar su borrador",
      now: NOW,
    });
    expect(dto).toMatchObject({ id: "imp-new", active: true });
    expect(dbState.inserts).toHaveLength(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "impersonation.start" }),
    );
  });
});

describe("endImpersonations", () => {
  beforeEach(() => {
    dbState.updates = [];
    recordAudit.mockClear();
  });

  it("writes one audit row per row it really closed", async () => {
    dbState.updateRows = [];
    const { db } = await import("../../db");
    expect(await endImpersonations(db, { id: "imp1" }, "stopped")).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();

    dbState.updateRows = [row({ endedAt: NOW, targetUserId: null })];
    await endImpersonations(db, { sessionId: "session-1" }, "signed_out", {
      ipAddress: "10.0.0.1",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "impersonation.stop",
        source: "auth",
        targetType: "impersonation",
        targetId: "imp1",
        ipAddress: "10.0.0.1",
      }),
    );
  });

  it("stops only an impersonated request", async () => {
    await expect(stopImpersonation(fakeEvent("DELETE"))).rejects.toThrowError(
      expect.objectContaining({ statusCode: 409 }),
    );
    dbState.updateRows = [row({ endedAt: NOW })];
    await stopImpersonation(
      fakeEvent("DELETE", {}, { impersonation: { id: "imp1" } }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "impersonation.stop",
        source: "user",
      }),
    );
  });
});

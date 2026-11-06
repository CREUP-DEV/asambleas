import type { H3Event } from "h3";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The role endpoint with the caller, the database and the audit stubbed:
// an account without access keeps its role, and an Admin without access
// does not count as the Admin who stays.

const USER_ID = "u".repeat(32);
const ADMIN_ROLE = { id: "radmin000000000000000000", name: "Admin" };
const INVITADO_ROLE = { id: "rinvitado000000000000000", name: "Invitado" };

const state = vi.hoisted(() => ({
  body: {} as unknown,
  targetRole: null as { id: string; name: string } | null,
  targetUser: null as Record<string, unknown> | null,
  admins: [] as { id: string }[],
  updated: [] as { id: string }[],
  adminsWhere: null as unknown,
  updateWhere: null as unknown,
}));

const recordAudit = vi.hoisted(() => vi.fn(async () => "audit-id"));
const endImpersonations = vi.hoisted(() => vi.fn(async () => []));

vi.mock("h3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("h3")>()),
  readBody: vi.fn(async () => state.body),
}));
vi.mock("../../../../utils/auth/rbac", () => ({
  ADMIN_GRANT_MESSAGES: {},
  adminGrantViolation: vi.fn(() => null),
  getUserPermissions: vi.fn(async () => []),
  requireAnyPermission: vi.fn(async () => ({
    admin: true,
    permissions: [],
    user: { id: "a".repeat(32) },
    impersonation: null,
  })),
  touchesLeadershipRole: vi.fn(() => false),
}));
vi.mock("../../../../utils/auth/impersonation", () => ({ endImpersonations }));
vi.mock("../../../../utils/domain/audit", () => ({ recordAudit }));
vi.mock("../../../../utils/validation", () => ({
  isDefaultCuid: () => true,
  validateAuthId: (id: string) => id,
}));
vi.mock("../../../../db", () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          state.adminsWhere = condition;
          return {
            orderBy: () => ({ for: async () => state.admins }),
          };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (condition: unknown) => {
          state.updateWhere = condition;
          return { returning: async () => state.updated };
        },
      }),
    }),
  };
  return {
    db: {
      query: {
        roles: { findFirst: async () => state.targetRole },
        users: { findFirst: async () => state.targetUser },
      },
      transaction: async (run: (inner: typeof tx) => Promise<unknown>) =>
        run(tx),
    },
  };
});

vi.stubGlobal("getRouterParam", () => USER_ID);

const { default: handler } = await import("./role.put");
const event = {} as H3Event;
const dialect = new PgDialect();
const render = (condition: unknown) => dialect.sqlToQuery(condition as SQL).sql;

async function failure(): Promise<{
  statusCode?: number;
  data?: { messageKey?: string };
}> {
  try {
    await handler(event);
  } catch (error) {
    return error as { statusCode?: number; data?: { messageKey?: string } };
  }
  throw new Error("the handler did not fail");
}

beforeEach(() => {
  state.body = { roleId: INVITADO_ROLE.id };
  state.targetRole = INVITADO_ROLE;
  state.targetUser = {
    id: USER_ID,
    email: "admin2@creup.es",
    roleId: ADMIN_ROLE.id,
    role: { name: ADMIN_ROLE.name },
    accessRevokedAt: null,
  };
  state.admins = [{ id: USER_ID }, { id: "b".repeat(32) }];
  state.updated = [{ id: USER_ID }];
  state.adminsWhere = null;
  state.updateWhere = null;
  recordAudit.mockClear();
});

describe("PUT /api/admin/users/[id]/role", () => {
  it("changes the role of an account with access", async () => {
    await expect(handler(event)).resolves.toMatchObject({
      success: true,
      roleName: INVITADO_ROLE.name,
    });
    expect(render(state.updateWhere)).toContain('"access_revoked_at" is null');
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("counts only the Admins who can sign in", async () => {
    await handler(event);
    const where = render(state.adminsWhere);
    expect(where).toContain('"role_id" =');
    expect(where).toContain('"access_revoked_at" is null');
  });

  it("keeps the last Admin who can sign in", async () => {
    // The other Admin lost access: only the target is left.
    state.admins = [{ id: USER_ID }];
    const error = await failure();
    expect(error.statusCode).toBe(409);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses to change the role of an account without access", async () => {
    state.body = { roleId: ADMIN_ROLE.id };
    state.targetRole = ADMIN_ROLE;
    state.targetUser = {
      ...state.targetUser,
      roleId: INVITADO_ROLE.id,
      role: { name: INVITADO_ROLE.name },
      accessRevokedAt: new Date("2026-11-01T10:00:00Z"),
    };
    const error = await failure();
    expect(error.statusCode).toBe(409);
    expect(error.data?.messageKey).toBe("admin.users.errors.targetRevoked");
    expect(state.updateWhere).toBeNull();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses when the account lost access while the request ran", async () => {
    state.updated = [];
    const error = await failure();
    expect(error.statusCode).toBe(409);
    expect(error.data?.messageKey).toBe("admin.users.errors.targetRevoked");
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

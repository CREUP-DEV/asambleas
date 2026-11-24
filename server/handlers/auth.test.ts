import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createError, createEvent, type H3Event } from "h3";
import { ACTING_USER_HEADER_NAME } from "~~/shared/constants/security";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

// The admin section handler with the auth context scripted (null: no
// session, 401 like requireAuth) and the same-origin and CSRF checks
// stubbed; the impersonation guards are real.
const context = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
const protection = vi.hoisted(() => ({
  assertSameOriginMutation: vi.fn(),
  ensureCsrfCookie: vi.fn(),
  assertCsrfMutation: vi.fn(),
}));

vi.mock("../db", () => ({ db: {} }));
vi.mock("../utils/auth/rbac", () => ({
  attachAuthContext: vi.fn(async (event: H3Event) => {
    if (!context.value) {
      throw createError({ statusCode: 401, message: "No autorizado" });
    }
    Object.assign(event.context, context.value);
  }),
}));
vi.mock("../utils/auth/requestProtection", () => protection);

const { default: handler } = await import("./auth");

function user(id: string, roleName: string) {
  return { id, role: { id: `role-${roleName}`, name: roleName } };
}

const admin = user("a".repeat(32), "Admin");
const secretaria = user("s".repeat(32), "Secretaria");
const asociado = user("t".repeat(32), "Asociado");
const ALL_SECTION_KEYS = [
  PERMISSION_KEYS.USER_MANAGE_ROLES,
  PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
];

function impersonating(target: ReturnType<typeof user>) {
  return {
    id: "imp1",
    admin: { id: admin.id, name: "Admin", email: "admin@creup.example" },
    targetUserId: target.id,
    reason: "Soporte",
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function signedIn(
  real: ReturnType<typeof user>,
  effective: ReturnType<typeof user>,
  permissions: string[],
  impersonation: ReturnType<typeof impersonating> | null = null,
) {
  context.value = {
    realUser: real,
    user: effective,
    role: effective.role,
    impersonation,
    permissions,
  };
}

function request(method: string, path: string, actingUser?: string) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path.slice("/api/admin".length) || "/";
  (req as IncomingMessage & { originalUrl?: string }).originalUrl = path;
  if (actingUser !== undefined) {
    req.headers[ACTING_USER_HEADER_NAME] = actingUser;
  }
  return createEvent(req, new ServerResponse(req));
}

describe("admin section handler", () => {
  beforeEach(() => {
    context.value = null;
    for (const fn of Object.values(protection)) fn.mockClear();
  });

  it("lets an Admin change things as themselves", async () => {
    signedIn(admin, admin, ALL_SECTION_KEYS);
    await expect(
      handler(request("PUT", "/api/admin/users/x/role", admin.id)),
    ).resolves.toBeUndefined();
    expect(protection.assertSameOriginMutation).toHaveBeenCalledTimes(1);
    expect(protection.assertCsrfMutation).toHaveBeenCalledTimes(1);
  });

  it("answers a stale identity with 409", async () => {
    // Another tab started acting as another account: this tab must reload,
    // not show a permission error.
    signedIn(admin, asociado, [], impersonating(asociado));
    await expect(
      handler(request("PUT", "/api/admin/users/x/role", admin.id)),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { messageKey: "auth.identityChanged" },
    });
    // And an Admin's mutation without the header.
    signedIn(admin, admin, ALL_SECTION_KEYS);
    await expect(
      handler(request("POST", "/api/admin/users/x/impersonate")),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("is read-only while impersonating, also for a second start", async () => {
    signedIn(admin, secretaria, ALL_SECTION_KEYS, impersonating(secretaria));
    for (const [method, path] of [
      ["PUT", "/api/admin/users/x/role"],
      ["PUT", "/api/admin/roles/r/permissions"],
      ["POST", "/api/admin/users/x/impersonate"],
    ] as const) {
      await expect(
        handler(request(method, path, secretaria.id)),
      ).rejects.toMatchObject({
        statusCode: 403,
        data: { messageKey: "admin.impersonationReadOnly" },
      });
    }
    // Reads stay open.
    await expect(
      handler(request("GET", "/api/admin/users")),
    ).resolves.toBeUndefined();
  });

  it("filters by no permission key: each endpoint checks its own", async () => {
    // Only stats:view: «Estadísticas» shows in the menu, so its requests
    // must reach GET /api/admin/stats, which checks stats:view itself.
    signedIn(asociado, asociado, [PERMISSION_KEYS.STATS_VIEW]);
    await expect(
      handler(request("GET", "/api/admin/stats")),
    ).resolves.toBeUndefined();
    // Only notification:manage, a change included.
    signedIn(asociado, asociado, [PERMISSION_KEYS.NOTIFICATION_MANAGE]);
    await expect(
      handler(request("PUT", "/api/admin/notifications", asociado.id)),
    ).resolves.toBeUndefined();
  });

  it("keeps out a request without a session", async () => {
    await expect(
      handler(request("GET", "/api/admin/stats")),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(protection.ensureCsrfCookie).not.toHaveBeenCalled();
  });
});

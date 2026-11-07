import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, type H3Event } from "h3";
import { ACTING_USER_HEADER_NAME } from "~~/shared/constants/security";

// The section handler with the auth context scripted and the same-origin and
// CSRF checks stubbed; the impersonation guards are the real ones.
const context = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const protection = vi.hoisted(() => ({
  assertSameOriginMutation: vi.fn(),
  ensureCsrfCookie: vi.fn(),
  assertCsrfMutation: vi.fn(),
}));

vi.mock("../db", () => ({ db: {} }));
vi.mock("../utils/auth/rbac", () => ({
  attachAuthContext: vi.fn(async (event: H3Event) => {
    Object.assign(event.context, context.value);
  }),
}));
vi.mock("../utils/auth/requestProtection", () => protection);

const {
  default: handler,
  isCalendarRulesPath,
  isMembersPath,
  isStopImpersonationRequest,
  requestPathname,
} = await import("./protected");

function user(id: string, roleName: string) {
  return { id, role: { id: `role-${roleName}`, name: roleName } };
}

const admin = user("a".repeat(32), "Admin");
const target = user("t".repeat(32), "Asociado");
const impersonation = {
  id: "imp1",
  admin: { id: admin.id, name: "Admin", email: "admin@creup.es" },
  targetUserId: target.id,
  reason: "Soporte",
  startedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
};

/** Signed in as `real`, acting as `effective` (the same when not impersonating). */
function signedIn(
  real: ReturnType<typeof user>,
  effective = real,
  current: typeof impersonation | null = null,
) {
  context.value = {
    realUser: real,
    user: effective,
    role: effective.role,
    impersonation: current,
    permissions: [],
  };
}

/**
 * A request as the protected middleware sees it: h3 slices the route
 * prefix off `url`, while `originalUrl` keeps the full path.
 */
function request(
  method: string,
  path: string,
  options: { prefix?: string; actingUser?: string } = {},
) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  const prefix =
    options.prefix ??
    ["/api/members", "/api/me", "/api/assemblies"].find((candidate) =>
      path.startsWith(candidate),
    ) ??
    "";
  req.url = path.slice(prefix.length) || "/";
  (req as IncomingMessage & { originalUrl?: string }).originalUrl = path;
  if (options.actingUser !== undefined) {
    req.headers[ACTING_USER_HEADER_NAME] = options.actingUser;
  }
  return createEvent(req, new ServerResponse(req));
}

const identityChanged = {
  statusCode: 409,
  data: { messageKey: "auth.identityChanged" },
};
const readOnly = {
  statusCode: 403,
  data: { messageKey: "admin.impersonationReadOnly" },
};

describe("protected section handler", () => {
  beforeEach(() => {
    context.value = {};
    for (const fn of Object.values(protection)) fn.mockClear();
  });

  it("keeps the same-origin and CSRF checks on every request", async () => {
    signedIn(admin);
    await handler(request("POST", "/api/assemblies", { actingUser: admin.id }));
    expect(protection.assertSameOriginMutation).toHaveBeenCalledTimes(1);
    expect(protection.ensureCsrfCookie).toHaveBeenCalledTimes(1);
    expect(protection.assertCsrfMutation).toHaveBeenCalledTimes(1);
  });

  it("requires an Admin's mutations to name the effective user", async () => {
    signedIn(admin);
    await expect(
      handler(request("POST", "/api/assemblies", { actingUser: admin.id })),
    ).resolves.toBeUndefined();
    await expect(
      handler(request("POST", "/api/assemblies")),
    ).rejects.toMatchObject(identityChanged);
    // Reads never need it.
    await expect(
      handler(request("GET", "/api/assemblies")),
    ).resolves.toBeUndefined();
  });

  it("refuses a tab that still believes it is the Admin while impersonating", async () => {
    signedIn(admin, target, impersonation);
    await expect(
      handler(
        request("PUT", "/api/assemblies/80-ago", { actingUser: target.id }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      handler(
        request("PUT", "/api/assemblies/80-ago", { actingUser: admin.id }),
      ),
    ).rejects.toMatchObject(identityChanged);
  });

  it("refuses a tab that still believes it impersonates after the end", async () => {
    signedIn(admin);
    await expect(
      handler(
        request("POST", "/api/assemblies/80-ago/export", {
          actingUser: target.id,
        }),
      ),
    ).rejects.toMatchObject(identityChanged);
  });

  it("checks a header that is present for everyone else", async () => {
    signedIn(target);
    await expect(
      handler(request("POST", "/api/assemblies")),
    ).resolves.toBeUndefined();
    await expect(
      handler(request("POST", "/api/assemblies", { actingUser: admin.id })),
    ).rejects.toMatchObject(identityChanged);
  });

  it("always lets the Admin go back to their account", async () => {
    signedIn(admin, target, impersonation);
    // The tab may name either identity, or none.
    for (const actingUser of [admin.id, target.id, undefined]) {
      await expect(
        handler(
          request("DELETE", "/api/me/impersonation", {
            prefix: "/api/me",
            actingUser,
          }),
        ),
      ).resolves.toBeUndefined();
    }
    expect(protection.assertCsrfMutation).toHaveBeenCalledTimes(3);
    // Only DELETE on that exact path is exempt.
    await expect(
      handler(
        request("POST", "/api/me/impersonation", { actingUser: admin.id }),
      ),
    ).rejects.toMatchObject(identityChanged);
    await expect(
      handler(
        request("DELETE", "/api/me/impersonation/other", {
          actingUser: admin.id,
        }),
      ),
    ).rejects.toMatchObject(identityChanged);
  });

  it("keeps members read-only while impersonating", async () => {
    signedIn(admin, target, impersonation);
    await expect(
      handler(request("POST", "/api/members", { actingUser: target.id })),
    ).rejects.toMatchObject(readOnly);
    await expect(
      handler(
        request("PUT", "/api/members/m1", {
          prefix: "/api/me",
          actingUser: target.id,
        }),
      ),
    ).rejects.toMatchObject(readOnly);
    await expect(
      handler(
        request("POST", "/api/%6Dembers/sync", { actingUser: target.id }),
      ),
    ).rejects.toMatchObject(readOnly);
    await expect(
      handler(request("GET", "/api/members")),
    ).resolves.toBeUndefined();
    // Domain actions stay allowed: they run as the account.
    await expect(
      handler(
        request("POST", "/api/assemblies/80-ago/documents", {
          actingUser: target.id,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("leaves members writable when nobody impersonates", async () => {
    signedIn(admin);
    await expect(
      handler(request("POST", "/api/members", { actingUser: admin.id })),
    ).resolves.toBeUndefined();
  });

  it("skips preflight requests", async () => {
    await expect(
      handler(request("OPTIONS", "/api/members")),
    ).resolves.toBeUndefined();
    expect(protection.assertSameOriginMutation).not.toHaveBeenCalled();
  });
});

describe("request path helpers", () => {
  function pathOf(originalUrl: string) {
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = "/";
    (req as IncomingMessage & { originalUrl?: string }).originalUrl =
      originalUrl;
    return requestPathname(createEvent(req, new ServerResponse(req)));
  }

  it("reads the full path, decoded like h3 routes it", () => {
    expect(pathOf("/api/members?all=1")).toBe("/api/members");
    expect(pathOf("/api/%6Dembers/x#y")).toBe("/api/members/x");
    expect(pathOf("//api///members")).toBe("/api/members");
    // Encoded slashes and percent signs stay encoded.
    expect(pathOf("/api%2Fmembers")).toBe("/api%2Fmembers");
    expect(pathOf("/api/members/%25")).toBe("/api/members/%25");
    expect(pathOf("/api/%E0%A4%A")).toBe("/api/%E0%A4%A");
  });

  it("recognises the members section", () => {
    expect(isMembersPath("/api/members")).toBe(true);
    expect(isMembersPath("/api/members/abc/x")).toBe(true);
    expect(isMembersPath("/api/Members")).toBe(true);
    expect(isMembersPath("/api/me")).toBe(false);
    expect(isMembersPath("/api/membership")).toBe(false);
    expect(isCalendarRulesPath("/api/calendar-rules")).toBe(true);
    expect(isCalendarRulesPath("/api/Calendar-Rules/AGO")).toBe(true);
    expect(isCalendarRulesPath("/api/calendar-rulesx")).toBe(false);
  });

  it("recognises only the stop request", () => {
    expect(isStopImpersonationRequest("DELETE", "/api/me/impersonation")).toBe(
      true,
    );
    expect(isStopImpersonationRequest("delete", "/api/me/impersonation/")).toBe(
      true,
    );
    expect(isStopImpersonationRequest("POST", "/api/me/impersonation")).toBe(
      false,
    );
    expect(isStopImpersonationRequest("DELETE", "/api/me/impersonations")).toBe(
      false,
    );
  });
});

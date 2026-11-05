import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent } from "h3";

// getAuthUserWithRole with the session, the user lookup and the
// impersonation resolver stubbed.
const findFirst = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
const resolveImpersonation = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ db: { query: { users: { findFirst } } } }));
vi.mock("./auth", () => ({ auth: { api: { getSession } } }));
vi.mock("./impersonation", () => ({ resolveImpersonation }));

const { getAuthUserWithRole } = await import("./requireAuth");

function fakeEvent() {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/me";
  return createEvent(req, new ServerResponse(req));
}

function user(id: string, roleName: string) {
  return {
    id,
    name: id,
    email: `${id}@creup.es`,
    image: null,
    roleId: `role-${roleName}`,
    externalRole: null,
    externalName: null,
    externalInitials: null,
    university: null,
    memberId: null,
    lastRoleSyncAt: null,
    role: { id: `role-${roleName}`, name: roleName },
  };
}

describe("getAuthUserWithRole", () => {
  beforeEach(() => {
    findFirst.mockReset();
    getSession.mockReset();
    resolveImpersonation.mockReset();
  });

  it("keeps the signed-in user when nobody is impersonating", async () => {
    const me = user("u1", "Asociado");
    getSession.mockResolvedValue({
      user: { id: "u1" },
      session: { id: "s1" },
    });
    findFirst.mockResolvedValue(me);
    resolveImpersonation.mockResolvedValue(null);

    const event = fakeEvent();
    expect(await getAuthUserWithRole(event)).toBe(me);
    expect(event.context).toMatchObject({
      user: me,
      realUser: me,
      impersonation: null,
      role: me.role,
    });
    expect(resolveImpersonation).toHaveBeenCalledWith(event, {
      sessionId: "s1",
      realUser: me,
    });

    // Cached for the rest of the request.
    await getAuthUserWithRole(event);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("runs the request as the target while an Admin impersonates", async () => {
    const admin = user("admin", "Admin");
    const target = user("target", "Moderador");
    const impersonation = { id: "imp1", targetUserId: "target" };
    getSession.mockResolvedValue({
      user: { id: "admin" },
      session: { id: "s1" },
    });
    findFirst.mockResolvedValue(admin);
    resolveImpersonation.mockResolvedValue({ user: target, impersonation });

    const event = fakeEvent();
    expect(await getAuthUserWithRole(event)).toBe(target);
    expect(event.context).toMatchObject({
      user: target,
      realUser: admin,
      impersonation,
      role: target.role,
    });
  });

  it("returns null for a session whose user row is gone", async () => {
    getSession.mockResolvedValue({ user: { id: "x" }, session: { id: "s" } });
    findFirst.mockResolvedValue(undefined);
    const event = fakeEvent();
    expect(await getAuthUserWithRole(event)).toBeNull();
    expect(resolveImpersonation).not.toHaveBeenCalled();
    expect(event.context.user).toBeUndefined();
  });

  it("rejects requests without a session", async () => {
    getSession.mockResolvedValue(null);
    await expect(getAuthUserWithRole(fakeEvent())).rejects.toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
});

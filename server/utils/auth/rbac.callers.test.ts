import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import type { Actor } from "../domain/actor";

// requireAnyPermission and requireAdmin read the request's Actor
// (requireActor, stubbed here): who passes, who is refused, and that the
// caller carries that same actor.
const getAuthUserWithRole = vi.hoisted(() => vi.fn());
const requireActor = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ db: {} }));
vi.mock("./requireAuth", () => ({
  getAuthUserWithRole,
  requireAuth: vi.fn(async () => ({ session: { id: "s1" } })),
}));
vi.mock("../domain/actor", async (original) => ({
  ...(await original<typeof import("../domain/actor")>()),
  requireActor,
}));

// rbac.ts first: domain/actor.ts imports it back, and rbac.ts must bind to
// the stubbed module, which testActor then shares.
const { requireAdmin, requireAnyPermission } = await import("./rbac");
const { testActor } = await import("../../testing/actor");

function fakeEvent() {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/admin/stats";
  return createEvent(req, new ServerResponse(req));
}

function actingAs(actor: Actor) {
  getAuthUserWithRole.mockResolvedValue(actor.user);
  requireActor.mockResolvedValue(actor);
}

const STATS = [PERMISSION_KEYS.STATS_VIEW];

describe("requireAnyPermission", () => {
  beforeEach(() => {
    getAuthUserWithRole.mockReset();
    requireActor.mockReset();
  });

  it("refuses a caller without any of the keys", async () => {
    actingAs(
      testActor({
        role: SYSTEM_ROLES.ASOCIADO,
        permissions: [PERMISSION_KEYS.NOTIFICATION_MANAGE],
      }),
    );
    await expect(
      requireAnyPermission(fakeEvent(), STATS),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("lets through a caller with one of them, with the request's actor", async () => {
    const actor = testActor({
      role: SYSTEM_ROLES.ASOCIADO,
      permissions: [PERMISSION_KEYS.STATS_VIEW],
    });
    actingAs(actor);
    const caller = await requireAnyPermission(fakeEvent(), [
      PERMISSION_KEYS.USER_MANAGE_ROLES,
      PERMISSION_KEYS.STATS_VIEW,
    ]);
    expect(caller.actor).toBe(actor);
    expect(caller).toMatchObject({
      admin: false,
      user: { id: actor.user.id, role: actor.user.role },
      permissions: [PERMISSION_KEYS.STATS_VIEW],
      impersonation: null,
    });
  });

  it("lets an Admin through with every key", async () => {
    actingAs(testActor({ role: SYSTEM_ROLES.ADMIN, permissions: [] }));
    const caller = await requireAnyPermission(fakeEvent(), STATS);
    expect(caller.admin).toBe(true);
  });

  it("answers 403 to a session whose account is gone", async () => {
    getAuthUserWithRole.mockResolvedValue(null);
    await expect(
      requireAnyPermission(fakeEvent(), STATS),
    ).rejects.toMatchObject({ statusCode: 403, message: "Sin rol asignado" });
    expect(requireActor).not.toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  beforeEach(() => {
    getAuthUserWithRole.mockReset();
    requireActor.mockReset();
  });

  it("refuses whoever is not an Admin, every key notwithstanding", async () => {
    actingAs(
      testActor({
        role: SYSTEM_ROLES.SECRETARIA,
        permissions: Object.values(PERMISSION_KEYS),
      }),
    );
    await expect(requireAdmin(fakeEvent())).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("lets an Admin through", async () => {
    const actor = testActor({ role: SYSTEM_ROLES.ADMIN });
    actingAs(actor);
    const caller = await requireAdmin(fakeEvent());
    expect(caller.admin).toBe(true);
    expect(caller.actor).toBe(actor);
  });

  it("answers 403 to a session whose account is gone", async () => {
    getAuthUserWithRole.mockResolvedValue(null);
    await expect(requireAdmin(fakeEvent())).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

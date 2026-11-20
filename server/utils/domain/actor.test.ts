import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent } from "h3";

// requireActor with the auth helpers stubbed: where the member's kind
// comes from.
const getAuthUserWithRole = vi.hoisted(() => vi.fn());
const memberReads = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => memberReads(),
  };
  return { db: { select: () => chain } };
});
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole,
  requireAuth: vi.fn(async () => ({ session: { id: "s1" } })),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(async () => []),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { requireActor } = await import("./actor");

function fakeEvent() {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/assemblies";
  return createEvent(req, new ServerResponse(req));
}

const user = {
  id: "u1",
  name: "u1",
  email: "u1@creup.example",
  image: null,
  roleId: "role-CEA",
  externalRole: null,
  externalName: null,
  externalInitials: null,
  university: null,
  memberId: "m1",
  lastRoleSyncAt: null,
  role: { id: "role-CEA", name: "CEA" },
};

describe("requireActor: the member's kind", () => {
  beforeEach(() => {
    getAuthUserWithRole.mockReset();
    memberReads.mockReset();
  });

  it("takes the kind read with the user, without a query of its own", async () => {
    const event = fakeEvent();
    getAuthUserWithRole.mockImplementation(async () => {
      event.context.memberKind = "executive";
      return user;
    });
    const actor = await requireActor(event);
    expect(actor.memberKind).toBe("executive");
    expect(memberReads).not.toHaveBeenCalled();
  });

  it("keeps a null kind (no member) without reading", async () => {
    const event = fakeEvent();
    getAuthUserWithRole.mockImplementation(async () => {
      event.context.memberKind = null;
      return { ...user, memberId: null };
    });
    const actor = await requireActor(event);
    expect(actor.memberKind).toBeNull();
    expect(memberReads).not.toHaveBeenCalled();
  });

  it("reads the effective user's kind while an Admin impersonates", async () => {
    const event = fakeEvent();
    // getAuthUserWithRole leaves memberKind unset then.
    getAuthUserWithRole.mockResolvedValue({ ...user, memberId: "m2" });
    memberReads.mockResolvedValue([{ kind: "asociado" }]);
    const actor = await requireActor(event);
    expect(actor.memberKind).toBe("asociado");
    expect(memberReads).toHaveBeenCalledTimes(1);
  });
});

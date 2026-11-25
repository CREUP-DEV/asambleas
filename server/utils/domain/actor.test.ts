import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent } from "h3";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";

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

const { buildActor, requireActor, requireCan } = await import("./actor");
const { publicExportActor } = await import("../export/actor");

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

describe("buildActor", () => {
  it("makes an Admin of the Admin role, who passes every check", () => {
    const actor = buildActor({
      user: { ...user, role: { id: "role-Admin", name: "Admin" } },
      permissions: [],
      memberKind: "executive",
      impersonation: null,
    });
    expect(actor.isAdmin).toBe(true);
    expect(actor.can(PERMISSION_KEYS.SESSION_MODERATE)).toBe(true);
    expect(actor.memberId).toBe("m1");
    expect(actor.memberKind).toBe("executive");
  });

  it("passes only the keys held by anyone else", () => {
    const actor = buildActor({
      user,
      permissions: [PERMISSION_KEYS.CONTROL_SHEET_VIEW],
      memberKind: null,
      impersonation: null,
    });
    expect(actor.isAdmin).toBe(false);
    expect(actor.can(PERMISSION_KEYS.CONTROL_SHEET_VIEW)).toBe(true);
    expect(actor.can(PERMISSION_KEYS.SESSION_MODERATE)).toBe(false);
  });

  it("builds the exports' public reader with no role, member or key", () => {
    const reader = publicExportActor();
    expect(reader.isAdmin).toBe(false);
    expect(reader.memberId).toBeNull();
    expect(reader.memberKind).toBeNull();
    expect(reader.impersonation).toBeNull();
    expect(reader.permissions).toEqual([]);
    expect(reader.can(PERMISSION_KEYS.DOCUMENT_MANAGE)).toBe(false);
  });
});

describe("requireCan", () => {
  const holding = (...permissions: PermissionKey[]) =>
    buildActor({ user, permissions, memberKind: null, impersonation: null });

  it("refuses whoever does not hold the key", () => {
    expect(() =>
      requireCan(holding(), PERMISSION_KEYS.ASSEMBLY_MANAGE),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() =>
      requireCan(
        holding(PERMISSION_KEYS.DOCUMENT_MANAGE),
        PERMISSION_KEYS.SESSION_MODERATE,
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it("checks the key itself: a key that implies it does not pass", () => {
    // amendment:manage implies amendment:review only through holdsPermission.
    expect(() =>
      requireCan(
        holding(PERMISSION_KEYS.AMENDMENT_MANAGE),
        PERMISSION_KEYS.AMENDMENT_REVIEW,
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it("lets the holder and an Admin through", () => {
    expect(() =>
      requireCan(
        holding(PERMISSION_KEYS.SESSION_MODERATE),
        PERMISSION_KEYS.SESSION_MODERATE,
      ),
    ).not.toThrow();
    const admin = buildActor({
      user: { ...user, role: { id: "role-Admin", name: "Admin" } },
      permissions: [],
      memberKind: null,
      impersonation: null,
    });
    expect(() =>
      requireCan(admin, PERMISSION_KEYS.MEMBER_MANAGE),
    ).not.toThrow();
  });
});

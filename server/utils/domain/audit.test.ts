import { readdirSync, readFileSync, statSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createEvent, type H3Event } from "h3";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";

vi.mock("../../db", () => ({ db: {} }));

const {
  AUDIT_USER_AGENT_MAX_LENGTH,
  isUnchangedAudit,
  recordAudit,
  requestActorRef,
  requestClientInfo,
  resolveAuditActor,
} = await import("./audit");

function fakeEvent(
  headers: Record<string, string> = {},
  context: Record<string, unknown> = {},
): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/api/test";
  req.headers = headers;
  const event = createEvent(req, new ServerResponse(req));
  Object.assign(event.context, context);
  return event;
}

/** An executor that records what recordAudit inserts. */
function fakeExecutor() {
  const inserted: Record<string, unknown>[] = [];
  const executor = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: async () => [{ id: `audit-${inserted.length}` }] };
      },
    }),
  };
  return { executor: executor as never, inserted };
}

const impersonating = {
  user: { id: "target" },
  realUser: { id: "admin" },
  impersonation: { id: "imp1" },
};

describe("resolveAuditActor", () => {
  it("takes the effective user and the impersonation from the request", () => {
    expect(resolveAuditActor({ event: fakeEvent({}, impersonating) })).toEqual({
      userId: "target",
      impersonationId: "imp1",
    });
    expect(resolveAuditActor({})).toEqual({
      userId: null,
      impersonationId: null,
    });
  });

  it("accepts an Actor or AdminCaller, an explicit ref, or nobody", () => {
    expect(
      resolveAuditActor({
        actor: { user: { id: "u1" }, impersonation: { id: "imp2" } },
      }),
    ).toEqual({ userId: "u1", impersonationId: "imp2" });
    expect(resolveAuditActor({ actor: { user: { id: "u1" } } })).toEqual({
      userId: "u1",
      impersonationId: null,
    });
    expect(resolveAuditActor({ actor: { userId: "admin" } })).toEqual({
      userId: "admin",
      impersonationId: null,
    });
    expect(
      resolveAuditActor({ event: fakeEvent({}, impersonating), actor: null }),
    ).toEqual({ userId: null, impersonationId: null });
  });

  it("lets an explicit impersonation id win", () => {
    expect(
      resolveAuditActor({
        event: fakeEvent({}, impersonating),
        impersonationId: null,
      }),
    ).toEqual({ userId: "target", impersonationId: null });
    expect(resolveAuditActor({ actor: null, impersonationId: "imp3" })).toEqual(
      { userId: null, impersonationId: "imp3" },
    );
  });

  it("names the request's actor for job data", () => {
    expect(requestActorRef(fakeEvent({}, impersonating))).toEqual({
      userId: "target",
      impersonationId: "imp1",
    });
    expect(requestActorRef(null)).toEqual({
      userId: null,
      impersonationId: null,
    });
  });
});

describe("requestClientInfo", () => {
  it("reads the first forwarded address and truncates the user agent", () => {
    const info = requestClientInfo(
      fakeEvent({
        "x-forwarded-for": "203.0.113.7, 10.0.0.2",
        "user-agent": "x".repeat(AUDIT_USER_AGENT_MAX_LENGTH + 50),
      }),
    );
    expect(info.ipAddress).toBe("203.0.113.7");
    expect(info.userAgent).toHaveLength(AUDIT_USER_AGENT_MAX_LENGTH);
    expect(requestClientInfo(null)).toEqual({
      ipAddress: null,
      userAgent: null,
    });
  });
});

describe("isUnchangedAudit", () => {
  it("is a no-op only with both sides given and equal", () => {
    expect(isUnchangedAudit({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(
      true,
    );
    expect(isUnchangedAudit({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(
      true,
    );
    expect(isUnchangedAudit({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(isUnchangedAudit(null, null)).toBe(false);
    expect(isUnchangedAudit(null, { a: 1 })).toBe(false);
    expect(isUnchangedAudit({ a: 1 }, undefined)).toBe(false);
  });
});

describe("recordAudit", () => {
  it("fills actor, impersonation, source and client from the request", async () => {
    const { executor, inserted } = fakeExecutor();
    const id = await recordAudit(executor, {
      event: fakeEvent(
        { "x-forwarded-for": "198.51.100.4", "user-agent": "Firefox" },
        impersonating,
      ),
      action: AUDIT_ACTIONS.EXPORT_REQUEST,
      targetType: "document",
      targetId: "doc1",
      assemblyId: "asm1",
      after: { jobId: "job1" },
    });
    expect(id).toBe("audit-1");
    expect(inserted[0]).toMatchObject({
      actorUserId: "target",
      impersonationId: "imp1",
      source: "user",
      action: "export.request",
      targetType: "document",
      targetId: "doc1",
      assemblyId: "asm1",
      before: null,
      after: { jobId: "job1" },
      ipAddress: "198.51.100.4",
      userAgent: "Firefox",
    });
  });

  it("takes explicit client data and actors from hooks without a request", async () => {
    const { executor, inserted } = fakeExecutor();
    await recordAudit(executor, {
      actor: { userId: "u1" },
      source: "auth",
      action: AUDIT_ACTIONS.AUTH_SIGN_IN,
      targetType: "user",
      targetId: "u1",
      ipAddress: "192.0.2.1",
      userAgent: null,
    });
    expect(inserted[0]).toMatchObject({
      actorUserId: "u1",
      impersonationId: null,
      source: "auth",
      assemblyId: null,
      ipAddress: "192.0.2.1",
      userAgent: null,
    });
  });

  it("skips a change that changes nothing, unless asked", async () => {
    const { executor, inserted } = fakeExecutor();
    const same = {
      action: AUDIT_ACTIONS.ROLE_ASSIGN,
      targetType: "user" as const,
      targetId: "u1",
      before: { roleId: "r1", roleName: "Asociado" },
      after: { roleName: "Asociado", roleId: "r1" },
    };
    expect(await recordAudit(executor, same)).toBeNull();
    expect(inserted).toHaveLength(0);
    expect(
      await recordAudit(executor, { ...same, recordUnchanged: true }),
    ).toBe("audit-1");
  });
});

// Only recordAudit writes audit_log --------------------------------------

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Files that still insert into audit_log directly, from before recordAudit.
 * Empty this list as each one moves to recordAudit; never add to it.
 */
const LEGACY_AUDIT_WRITERS: readonly string[] = [
  "server/api/admin/roles/[id]/permissions.put.ts",
  "server/api/admin/users/[id]/member.put.ts",
  "server/api/admin/users/[id]/permissions.put.ts",
  "server/api/admin/users/[id]/role.put.ts",
  "server/api/assemblies/[assembly]/index.delete.ts",
  "server/api/members/index.post.ts",
  "server/api/members/[id].put.ts",
  "server/utils/members/sync.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)
      ? [path]
      : [];
  });
}

describe("audit_log writers", () => {
  it("insert only through recordAudit", () => {
    const writers = [
      ...sourceFiles(join(root, "server")),
      ...sourceFiles(join(root, "drizzle")),
    ]
      .map((path) => relative(root, path).split(sep).join("/"))
      .filter((path) =>
        /\.insert\(\s*(?:schema\.)?auditLog\s*\)/.test(
          readFileSync(join(root, path), "utf8"),
        ),
      );
    // The scan sees recordAudit itself, so it is looking in the right place.
    expect(writers).toContain("server/utils/domain/audit.ts");
    expect(
      writers.filter(
        (path) =>
          path !== "server/utils/domain/audit.ts" &&
          !LEGACY_AUDIT_WRITERS.includes(path),
      ),
    ).toEqual([]);
  });
});

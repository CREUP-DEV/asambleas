import { afterAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "./actor";

/**
 * Opt-in check of the activity SQL against a real database (the UNION ALL,
 * the keyset and every filter combination the unit tests only render):
 *
 *   ACTIVITY_DB_TEST=1 pnpm exec vitest run server/utils/domain/activity.db.test.ts
 *
 * It reads, except for one ended impersonation with two audit rows that it
 * writes and deletes again, and the sweep GET /api/admin/impersonations runs
 * (closing impersonations already past their expiry). Use a development
 * database. Skipped otherwise, and nothing touching the database is
 * imported then.
 */
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const enabled = Boolean(process.env.ACTIVITY_DB_TEST);

describe.skipIf(!enabled)("activity SQL on the database", () => {
  const load = async () => {
    const { db } = await import("../../db");
    const schema = await import("../../db/schema");
    const activity = await import("./activity");
    const { decodeActivityCursor } =
      await import("~~/shared/utils/schemas/activity");
    return { db, schema, activity, decodeActivityCursor };
  };

  afterAll(async () => {
    if (!enabled) return;
    const { db } = await import("../../db");
    await db.$client.end();
  });

  function actorOf(
    user: { id: string; name: string; email: string; memberId: string | null },
    isAdmin: boolean,
  ): Actor {
    return {
      user: {
        ...user,
        image: null,
        roleId: null,
        externalRole: null,
        externalName: null,
        externalInitials: null,
        university: null,
        lastRoleSyncAt: null,
        role: null,
      },
      memberId: user.memberId ?? "zzzzzzzzzzzzzzzzzzzzzzzz",
      isAdmin,
      permissions: [],
      can: () => isAdmin,
      impersonation: null,
    };
  }

  it("runs every tab and pages without repeating rows", async () => {
    const { db, schema, activity, decodeActivityCursor } = await load();
    const [user] = await db.select().from(schema.users).limit(1);
    expect(user).toBeDefined();

    for (const isAdmin of [false, true]) {
      const actor = actorOf(user!, isAdmin);
      for (const tab of ["by", "to", "access", "member"] as const) {
        const page = await activity.loadMeActivity(actor, {
          tab,
          limit: 50,
          category: tab === "by" ? ["document", "other", "access"] : undefined,
          from: "2000-01-01T00:00:00Z",
          to: "2100-01-01T00:00:00Z",
        });
        expect(Array.isArray(page.items)).toBe(true);
        expect(Array.isArray(page.recentImpersonations)).toBe(true);
      }

      const first = await activity.loadMeActivity(actor, {
        tab: "by",
        limit: 1,
      });
      if (first.nextCursor) {
        const cursor = decodeActivityCursor(first.nextCursor)!;
        expect(cursor.at).toMatch(/\.\d{6}Z$/);
        const second = await activity.loadMeActivity(actor, {
          tab: "by",
          limit: 1,
          cursor,
        });
        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      }
    }
  });

  it("runs the Admin log with its filters", async () => {
    const { db, schema, activity, decodeActivityCursor } = await load();
    const [user] = await db.select().from(schema.users).limit(1);
    const [assembly] = await db
      .select({
        number: schema.assemblies.number,
        type: schema.assemblies.type,
      })
      .from(schema.assemblies)
      .limit(1);

    // Paging through the whole log reads every row once, newest first.
    const { sql } = await import("drizzle-orm");
    const totals = await db.execute<{ total: string }>(
      sql`select (select count(*) from events) + (select count(*) from audit_log) + (select count(*) from impersonations) as total`,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await activity.loadAdminActivity({
        limit: 3,
        ...(cursor ? { cursor: decodeActivityCursor(cursor)! } : {}),
      });
      seen.push(...page.items.map((item) => `${item.kind}:${item.id}`));
      const times = page.items.map((item) => item.at);
      expect([...times].sort().reverse()).toEqual(times);
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(Number(totals.rows[0]!.total));

    const plans = [
      { actor: user!.id },
      { target: user!.id },
      { user: user!.id, impersonated: false },
      { member: "zzzzzzzzzzzzzzzzzzzzzzzz" },
      { action: ["assembly_created", "role.assign", "impersonation.session"] },
      { category: ["document" as const, "other" as const] },
      { kind: ["audit" as const], source: ["user" as const, "auth" as const] },
      { impersonated: true, impersonation: "zzzzzzzzzzzzzzzzzzzzzzzz" },
      { q: "a_%" },
      { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" },
      ...(assembly
        ? [{ assembly: `${assembly.number}-${assembly.type.toLowerCase()}` }]
        : []),
    ];
    for (const plan of plans) {
      const page = await activity.loadAdminActivity({ limit: 20, ...plan });
      expect(Array.isArray(page.items)).toBe(true);
    }

    for (const active of [undefined, true, false]) {
      const page = await activity.loadAdminImpersonations({
        limit: 5,
        active,
        admin: active === false ? user!.id : undefined,
      });
      expect(Array.isArray(page.items)).toBe(true);
    }

    // Lookups of rows whose document and amendment no longer exist.
    const lookups = await activity.loadActivityLookups([
      {
        kind: "event",
        id: "zzzzzzzzzzzzzzzzzzzzzzzz",
        at: "2026-01-01T00:00:00.000000Z",
        action: "amendment_deleted",
        source: "user",
        actorUserId: user!.id,
        actorMemberId: null,
        impersonationId: null,
        assemblyId: null,
        targetType: "amendment",
        targetId: "yyyyyyyyyyyyyyyyyyyyyyyy",
        payload: {},
        ipAddress: null,
        userAgent: null,
        approximate: null,
      },
      {
        kind: "audit",
        id: "xxxxxxxxxxxxxxxxxxxxxxxx",
        at: "2026-01-01T00:00:00.000000Z",
        action: "export.request",
        source: "user",
        actorUserId: user!.id,
        actorMemberId: null,
        impersonationId: null,
        assemblyId: null,
        targetType: "document",
        targetId: "wwwwwwwwwwwwwwwwwwwwwwww",
        payload: { before: null, after: null },
        ipAddress: null,
        userAgent: null,
        approximate: null,
      },
    ]);
    expect(lookups.amendments.size).toBe(0);
    expect(lookups.users.get(user!.id)).toBeDefined();
  });

  it("lists an impersonation with what was done under it", async () => {
    const { db, schema, activity } = await load();
    const { eq } = await import("drizzle-orm");
    const { recordAudit } = await import("./audit");
    const [user] = await db.select().from(schema.users).limit(1);
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [row] = await db
      .insert(schema.impersonations)
      .values({
        adminUserId: user!.id,
        targetUserId: user!.id,
        sessionId: "activity-db-test",
        reason: "activity.db.test",
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 60 * 60 * 1000),
        endedAt: new Date(startedAt.getTime() + 30 * 60 * 1000),
        endReason: "stopped",
        ipAddress: "192.0.2.10",
      })
      .returning({ id: schema.impersonations.id });
    const id = row!.id;
    try {
      const actor = { userId: user!.id, impersonationId: id };
      // Its own row (not counted) and one change done under it (counted).
      await recordAudit(db, {
        actor,
        action: "impersonation.start",
        targetType: "user",
        targetId: user!.id,
        after: { reason: "activity.db.test" },
      });
      await recordAudit(db, {
        actor,
        action: "export.request",
        targetType: "document",
        targetId: "wwwwwwwwwwwwwwwwwwwwwwww",
        after: { variant: "base" },
      });

      const page = await activity.loadAdminImpersonations({
        limit: 50,
        target: user!.id,
      });
      const item = page.items.find((entry) => entry.id === id);
      expect(item).toMatchObject({
        reason: "activity.db.test",
        endReason: "stopped",
        active: false,
        ipAddress: "192.0.2.10",
        actionCount: 1,
        admin: { id: user!.id },
        target: { id: user!.id },
      });
      expect(item!.target).toHaveProperty("member");
      expect(item!.target).toHaveProperty("role");

      const log = await activity.loadAdminActivity({
        limit: 50,
        impersonation: id,
      });
      expect(log.items.map((entry) => entry.action).sort()).toEqual([
        "export.request",
        "impersonation.session",
        "impersonation.start",
      ]);
    } finally {
      await db
        .delete(schema.auditLog)
        .where(eq(schema.auditLog.impersonationId, id));
      await db
        .delete(schema.impersonations)
        .where(eq(schema.impersonations.id, id));
    }
  });
});

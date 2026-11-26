import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeWorkNewsDto } from "~~/shared/types/api";

// The database is a recorder: reads resolve to `rows.next`, writes keep
// what they were given, so the rules are checked without a database.
const calls = vi.hoisted(() => ({
  selects: 0,
  rows: [] as unknown[],
  inserts: [] as { values: unknown; conflict: unknown }[],
}));

vi.mock("../../db", () => {
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (value: unknown) => unknown) =>
              resolve(calls.rows);
          }
          return () => chain();
        },
      },
    );
  return {
    db: {
      select: () => {
        calls.selects += 1;
        return chain();
      },
      selectDistinct: () => {
        calls.selects += 1;
        return chain();
      },
      insert: () => {
        const entry: { values: unknown; conflict: unknown } = {
          values: undefined,
          conflict: undefined,
        };
        calls.inserts.push(entry);
        return {
          values(values: unknown) {
            entry.values = values;
            return {
              onConflictDoUpdate(conflict: unknown) {
                entry.conflict = conflict;
                return Promise.resolve();
              },
            };
          },
        };
      },
    },
  };
});
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));
vi.mock("./news", () => ({ loadWorkNews: vi.fn() }));
vi.mock("./review", () => ({
  loadWorkAssemblies: vi.fn(),
  assemblyRef: (row: { id: string }) => ({
    id: row.id,
    slug: row.id,
    label: row.id,
  }),
}));
vi.mock("./documents", () => ({ assemblySettings: () => ({}) }));

const { testActor } = await import("../../testing/actor");
const { PERMISSION_KEYS } = await import("~~/shared/constants/permissions");
const { loadWorkNews } = await import("./news");
const { loadWorkAssemblies } = await import("./review");
const { loadNotices, markNoticesSeen } = await import("./notices");

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

const impersonation = {
  id: "imp1",
  admin: { id: "a".repeat(32), name: "Admin", email: "admin@example.org" },
  targetUserId: "u".repeat(32),
  reason: "Soporte",
  startedAt: new Date("2026-11-25T10:00:00Z"),
  expiresAt: new Date("2026-11-25T11:00:00Z"),
};

function news(
  id: string,
  at: string,
  extra: Partial<MeWorkNewsDto> = {},
): MeWorkNewsDto {
  return {
    id,
    assembly: { id: "s1", slug: "80-ago", label: "80.ª AGO" },
    document: { id: "d1", slug: "doc", title: "Doc" },
    amendment: { id: "am1", code: "UPV1", kind: "partial" },
    ownAmendment: true,
    type: "amendment_validated",
    by: null,
    value: null,
    at,
    ...extra,
  };
}

beforeEach(() => {
  calls.selects = 0;
  calls.rows = [];
  calls.inserts = [];
  vi.mocked(loadWorkNews).mockReset();
  vi.mocked(loadWorkAssemblies).mockReset();
});

describe("markNoticesSeen", () => {
  it("writes nothing while an Admin acts as the account", async () => {
    const actor = testActor({ memberId: "m1", impersonation });
    expect(await markNoticesSeen(actor, new Date())).toBe(false);
    expect(calls.inserts).toEqual([]);
  });

  it("clamps the mark to the present and never moves it back", async () => {
    const actor = testActor({ memberId: "m1" });
    const at = new Date("2026-11-25T12:00:00.000Z");
    expect(await markNoticesSeen(actor, at)).toBe(true);
    const [write] = calls.inserts;
    const values = write!.values as { userId: string; seenAt: SQL };
    expect(values.userId).toBe(actor.user.id);
    const clamp = render(values.seenAt);
    expect(clamp.sql).toBe("least($1::timestamptz, now())");
    expect(clamp.params).toEqual(["2026-11-25T12:00:00.000Z"]);
    const conflict = write!.conflict as { set: { seenAt: SQL } };
    expect(render(conflict.set.seenAt).sql).toBe(
      'greatest("notice_seen"."seen_at", excluded.seen_at)',
    );
  });
});

describe("loadNotices", () => {
  it("counts as new only the rows later than the mark, after the repeats go", async () => {
    vi.mocked(loadWorkAssemblies).mockResolvedValue([
      { id: "s1", status: "convened" },
    ] as never);
    const at = "2026-11-25T12:00:00.000Z";
    vi.mocked(loadWorkNews).mockResolvedValue({
      news: [
        // One decision told twice: the rejection stays, the withdrawal goes.
        news("w", at, {
          amendment: { id: "t1", code: "T1", kind: "transactional" },
          type: "amendment_withdrawn",
        }),
        news("r", at, {
          amendment: { id: "t1", code: "T1", kind: "transactional" },
          type: "acceptance_recorded",
          value: "rejected",
        }),
        news("old", "2026-11-20T09:00:00.000Z"),
      ],
      watchDocumentIds: ["d1"],
      watchAssemblyIds: [],
    });
    calls.rows = [{ seenAt: new Date("2026-11-24T00:00:00Z") }];
    const dto = await loadNotices(testActor({ memberId: "m1" }));
    expect(dto.items.map((item) => item.id)).toEqual(["r", "old"]);
    expect(dto.seenAt).toBe("2026-11-24T00:00:00.000Z");
    expect(dto.unread).toBe(1);
    // The watched documents come with the news, from the same queries:
    // only the mark is read apart.
    expect(dto.watchDocumentIds).toEqual(["d1"]);
    expect(calls.selects).toBe(1);
  });

  it("counts an answer as new from when it became public, not from when it was recorded", async () => {
    vi.mocked(loadWorkAssemblies).mockResolvedValue([
      { id: "s1", status: "convened" },
    ] as never);
    vi.mocked(loadWorkNews).mockResolvedValue({
      news: [
        news("p", "2026-11-20T09:00:00.000Z", {
          type: "position_changed",
          value: "accept",
          visibleAt: "2026-11-25T10:00:00.000Z",
        }),
      ],
      watchDocumentIds: ["d1"],
      watchAssemblyIds: [],
    });
    calls.rows = [{ seenAt: new Date("2026-11-24T00:00:00Z") }];
    const dto = await loadNotices(testActor({ memberId: "m1" }));
    expect(dto.unread).toBe(1);
  });

  it("counts every row as new without a mark", async () => {
    vi.mocked(loadWorkAssemblies).mockResolvedValue([
      { id: "s1", status: "convened" },
    ] as never);
    vi.mocked(loadWorkNews).mockResolvedValue({
      news: [
        news("a", "2026-11-25T12:00:00.000Z"),
        news("b", "2026-11-24T12:00:00.000Z", {
          amendment: { id: "am2", code: "UPV2", kind: "partial" },
        }),
      ],
      watchDocumentIds: ["d1"],
      watchAssemblyIds: [],
    });
    calls.rows = [];
    const dto = await loadNotices(testActor({ memberId: "m1" }));
    expect(dto.seenAt).toBeNull();
    expect(dto.unread).toBe(2);
  });

  it("watches no document for an account without a member", async () => {
    vi.mocked(loadWorkAssemblies).mockResolvedValue([
      { id: "s1", status: "convened" },
    ] as never);
    vi.mocked(loadWorkNews).mockResolvedValue({
      news: [],
      watchDocumentIds: [],
      watchAssemblyIds: [],
    });
    const dto = await loadNotices(testActor());
    expect(dto.watchDocumentIds).toEqual([]);
    expect(dto.watchAssemblyIds).toEqual([]);
    expect(dto.unread).toBe(0);
    // Only the mark was read.
    expect(calls.selects).toBe(1);
  });

  it("gives the Mesa's notices to a moderator without a member, and watches its assemblies", async () => {
    vi.mocked(loadWorkAssemblies).mockResolvedValue([
      { id: "s1", status: "in_session" },
    ] as never);
    vi.mocked(loadWorkNews).mockResolvedValue({
      news: [
        news("ready", "2026-11-25T12:00:00.000Z", {
          amendment: { id: "t1", code: "T1", kind: "transactional" },
          ownAmendment: false,
          type: "acceptance_recorded",
          value: "ready",
          asMesa: true,
        }),
      ],
      watchDocumentIds: [],
      watchAssemblyIds: ["s1"],
    });
    calls.rows = [];
    const actor = testActor({
      permissions: [PERMISSION_KEYS.SESSION_MODERATE],
    });
    const dto = await loadNotices(actor);
    expect(vi.mocked(loadWorkNews).mock.calls[0]![0]).toBe(actor);
    expect(dto.items.map((item) => item.id)).toEqual(["ready"]);
    expect(dto.unread).toBe(1);
    expect(dto.watchDocumentIds).toEqual([]);
    expect(dto.watchAssemblyIds).toEqual(["s1"]);
  });
});

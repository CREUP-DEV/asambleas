import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The permission caches of rbac.ts with the database reads stubbed: each
// `db.select()...where()` answers with the next deferred result.
const reads = vi.hoisted(() => ({
  queue: [] as {
    resolve: (rows: { key: string }[]) => void;
    reject: (error: unknown) => void;
  }[],
  count: 0,
}));

vi.mock("../../db", () => {
  const where = () => {
    reads.count += 1;
    return new Promise((resolve, reject) => {
      reads.queue.push({ resolve, reject });
    });
  };
  const chain = { from: () => chain, innerJoin: () => chain, where };
  return { db: { select: () => chain } };
});
vi.mock("./requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));

const {
  clearPermissionCache,
  getUserExtraPermissions,
  getUserPermissions,
  invalidatePermissionCache,
  invalidateUserPermissionCache,
  PERMISSION_CACHE_TTL_MS,
} = await import("./rbac");

/** Answers the oldest pending read. */
function answer(keys: string[]) {
  const next = reads.queue.shift();
  if (!next) throw new Error("no pending read");
  next.resolve(keys.map((key) => ({ key })));
}

describe("permission caches", () => {
  beforeEach(() => {
    clearPermissionCache();
    reads.queue.length = 0;
    reads.count = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one read among concurrent requests and keeps it", async () => {
    const first = getUserPermissions("role-1");
    const second = getUserPermissions("role-1");
    expect(reads.count).toBe(1);
    answer(["session:moderate"]);
    expect(await first).toEqual(["session:moderate"]);
    expect(await second).toEqual(["session:moderate"]);

    expect(await getUserPermissions("role-1")).toEqual(["session:moderate"]);
    expect(reads.count).toBe(1);
  });

  it("reads again once the TTL has passed", async () => {
    vi.useFakeTimers();
    const first = getUserExtraPermissions("user-1");
    answer([]);
    await first;

    vi.advanceTimersByTime(PERMISSION_CACHE_TTL_MS - 1);
    await getUserExtraPermissions("user-1");
    expect(reads.count).toBe(1);

    vi.advanceTimersByTime(1);
    const again = getUserExtraPermissions("user-1");
    expect(reads.count).toBe(2);
    answer(["stats:view"]);
    expect(await again).toEqual(["stats:view"]);
  });

  it("never caches a read that started before an invalidation", async () => {
    // A read in flight while the admin's write commits...
    const stale = getUserPermissions("role-1");
    invalidatePermissionCache("role-1");
    // ...and one after the invalidation: they must not be shared.
    const fresh = getUserPermissions("role-1");
    expect(reads.count).toBe(2);

    answer(["document:create"]); // the old grants
    answer(["document:create", "amendment:create"]);
    expect(await stale).toEqual(["document:create"]);
    expect(await fresh).toEqual(["document:create", "amendment:create"]);

    // What stays cached is the read made after the write.
    expect(await getUserPermissions("role-1")).toEqual([
      "document:create",
      "amendment:create",
    ]);
    expect(reads.count).toBe(2);
  });

  it("drops a stale read in flight of a user's grants too", async () => {
    const stale = getUserExtraPermissions("user-1");
    invalidateUserPermissionCache("user-1");
    answer([]);
    expect(await stale).toEqual([]);

    const next = getUserExtraPermissions("user-1");
    expect(reads.count).toBe(2);
    answer(["stats:view"]);
    expect(await next).toEqual(["stats:view"]);
  });

  it("caches nothing when the read fails", async () => {
    const failed = getUserPermissions("role-1");
    reads.queue.shift()!.reject(new Error("pool timeout"));
    await expect(failed).rejects.toThrow("pool timeout");

    const retried = getUserPermissions("role-1");
    expect(reads.count).toBe(2);
    answer(["session:moderate"]);
    expect(await retried).toEqual(["session:moderate"]);
  });

  it("keeps roles and users apart", async () => {
    const role = getUserPermissions("same-id");
    const user = getUserExtraPermissions("same-id");
    expect(reads.count).toBe(2);
    answer(["session:moderate"]);
    answer(["stats:view"]);
    expect(await role).toEqual(["session:moderate"]);
    expect(await user).toEqual(["stats:view"]);
  });
});

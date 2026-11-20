import { beforeEach, describe, expect, it, vi } from "vitest";

// loadExecutiveMemberIds with the members read stubbed: each
// `select().from().where()` answers with the next deferred result.
const reads = vi.hoisted(() => ({
  queue: [] as {
    resolve: (rows: { id: string }[]) => void;
    reject: (error: unknown) => void;
  }[],
  count: 0,
}));

function chainFor(onRead: () => Promise<unknown>) {
  const chain = { from: () => chain, where: onRead };
  return { select: () => chain };
}

vi.mock("../../db", () => ({
  db: chainFor(() => {
    reads.count += 1;
    return new Promise((resolve, reject) => {
      reads.queue.push({ resolve, reject });
    });
  }),
}));
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock("../auth/rbac", () => ({
  getEffectivePermissions: vi.fn(),
  isAdmin: (name: string | null | undefined) => name === "Admin",
}));

const { loadExecutiveMemberIds } = await import("./executiveMembers");

function answer(ids: string[]) {
  const next = reads.queue.shift();
  if (!next) throw new Error("no pending read");
  next.resolve(ids.map((id) => ({ id })));
}

describe("loadExecutiveMemberIds", () => {
  beforeEach(() => {
    reads.queue.length = 0;
    reads.count = 0;
  });

  it("shares the read in flight, giving each caller its own set", async () => {
    const first = loadExecutiveMemberIds();
    const second = loadExecutiveMemberIds();
    expect(reads.count).toBe(1);
    answer(["sg", "pres"]);
    const [a, b] = await Promise.all([first, second]);
    expect([...a]).toEqual(["sg", "pres"]);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
  });

  it("keeps nothing once the read answers: a new office shows at once", async () => {
    const first = loadExecutiveMemberIds();
    answer(["sg"]);
    await first;

    const next = loadExecutiveMemberIds();
    expect(reads.count).toBe(2);
    answer(["sg", "new-office"]);
    expect([...(await next)]).toEqual(["sg", "new-office"]);
  });

  it("does not keep a failed read", async () => {
    const failed = loadExecutiveMemberIds();
    reads.queue.shift()!.reject(new Error("pool timeout"));
    await expect(failed).rejects.toThrow("pool timeout");

    const retried = loadExecutiveMemberIds();
    expect(reads.count).toBe(2);
    answer(["sg"]);
    expect([...(await retried)]).toEqual(["sg"]);
  });

  it("always reads inside a transaction", async () => {
    let txReads = 0;
    const tx = chainFor(async () => {
      txReads += 1;
      return [{ id: "sg" }];
    }) as unknown as Parameters<typeof loadExecutiveMemberIds>[0];
    const outside = loadExecutiveMemberIds();
    await loadExecutiveMemberIds(tx);
    await loadExecutiveMemberIds(tx);
    expect(txReads).toBe(2);
    answer([]);
    await outside;
    expect(reads.count).toBe(1);
  });
});

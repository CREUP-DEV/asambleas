import { afterAll, describe, expect, it } from "vitest";

/**
 * Opt-in check of a registered vote's ballots against a real database
 * (resolveRollCallBallots: the latest headcount's voters, their delegates,
 * the roll call's order and the counts):
 *
 *   ROLLCALL_DB_TEST=1 pnpm exec vitest run server/utils/domain/rollCall.db.test.ts
 *
 * It only reads. It needs an assembly with a headcount; skipped otherwise,
 * and nothing touching the database is imported then.
 */
const enabled = Boolean(process.env.ROLLCALL_DB_TEST);

describe.skipIf(!enabled)("registered vote ballots on the database", () => {
  afterAll(async () => {
    if (!enabled) return;
    const { db } = await import("../../db");
    await db.$client.end();
  });

  it("calls the latest headcount's voters and counts their ballots", async () => {
    const { db } = await import("../../db");
    const { headcounts } = await import("../../db/schema");
    const { desc } = await import("drizzle-orm");
    const { resolveRollCallBallots } = await import("./headcounts");
    const [latest] = await db
      .select({ assemblyId: headcounts.assemblyId })
      .from(headcounts)
      .orderBy(desc(headcounts.takenAt))
      .limit(1);
    expect(latest).toBeDefined();
    const empty = await resolveRollCallBallots(latest!.assemblyId, []);
    // Every voter called, none marked: nobody votes.
    expect(empty.ballots.length).toBeGreaterThan(0);
    expect(empty.counts.notCast).toBe(empty.ballots.length);
    expect(empty.counts.present).toBe(empty.ballots.length);
    const [first, second] = empty.ballots;
    const resolved = await resolveRollCallBallots(latest!.assemblyId, [
      { memberId: first!.memberId, choice: "in_favor" },
      ...(second
        ? [{ memberId: second.memberId, choice: "against" as const }]
        : []),
    ]);
    expect(resolved.counts.inFavor).toBe(1);
    expect(resolved.counts.against).toBe(second ? 1 : 0);
    expect(resolved.ballots.map((ballot) => ballot.memberId)).toEqual(
      empty.ballots.map((ballot) => ballot.memberId),
    );
    // A delegated voter names who votes for it.
    for (const ballot of resolved.ballots) {
      if (ballot.delegate) expect(ballot.delegate.acronym).not.toBe("");
    }
    await expect(
      resolveRollCallBallots(latest!.assemblyId, [
        { memberId: "not-a-member", choice: "in_favor" },
      ]),
    ).rejects.toMatchObject({ statusCode: 422 });
    // Called from another headcount than the latest: 409.
    await expect(
      resolveRollCallBallots(latest!.assemblyId, [], 0, db, "an-older-count"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (
        await resolveRollCallBallots(
          latest!.assemblyId,
          [],
          0,
          db,
          empty.headcountId,
        )
      ).headcountId,
    ).toBe(empty.headcountId);
  });
});

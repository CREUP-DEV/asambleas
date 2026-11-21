import { afterAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "./actor";

/**
 * Opt-in check of the votes that decide several amendments at once (on a
 * bloc, between alternatives, and their reopening) against a real
 * database, end to end through the domain:
 *
 *   MULTIVOTE_DB_TEST=1 MULTIVOTE_ASSEMBLY=80-ago MULTIVOTE_DOCUMENT=<slug> \
 *     pnpm exec vitest run server/utils/domain/multiVote.db.test.ts
 *
 * IT WRITES: it records votes on open amendments of that document (an
 * assembly in session) and reopens them, leaving votes and events behind.
 * Dump the development database first and restore it after. Skipped
 * otherwise, and nothing touching the database is imported then.
 */
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));

const enabled = Boolean(process.env.MULTIVOTE_DB_TEST);

describe.skipIf(!enabled)(
  "votes on several amendments, on the database",
  () => {
    afterAll(async () => {
      if (!enabled) return;
      const { db } = await import("../../db");
      await db.$client.end();
    });

    async function setup() {
      const { db } = await import("../../db");
      const schema = await import("../../db/schema");
      const { eq } = await import("drizzle-orm");
      const { ALL_PERMISSION_KEYS } =
        await import("~~/shared/constants/permissions");
      const [user] = await db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .limit(1);
      const actor = {
        user: { id: user!.id, name: user!.name, role: { name: "Admin" } },
        memberId: null,
        memberKind: null,
        isAdmin: true,
        permissions: [...ALL_PERMISSION_KEYS],
        can: () => true,
      } as unknown as Actor;
      const { resolveAssembly, resolveDocument } = await import("./resolvers");
      const { loadMilestones } = await import("./documents");
      const { loadAnswersOnValidation } = await import("./executiveMembers");
      const domain = await import("./amendments");
      const assembly = await resolveAssembly(
        actor,
        process.env.MULTIVOTE_ASSEMBLY,
      );
      const document = await resolveDocument(
        actor,
        assembly.id,
        process.env.MULTIVOTE_DOCUMENT,
      );
      const ctx = domain.buildDocumentAmendmentContext(
        actor,
        assembly,
        document,
        await loadMilestones(assembly.id),
        await loadAnswersOnValidation(document),
      );
      const open = async () =>
        (
          await db
            .select({
              id: schema.amendments.id,
              kind: schema.amendments.kind,
              updatedAt: schema.amendments.updatedAt,
            })
            .from(schema.amendments)
            .where(eq(schema.amendments.documentId, document.id))
        ).filter((row) => row.kind !== "transactional");
      const fresh = async (ids: string[]) => {
        const dtos = await Promise.all(
          ids.map((id) => domain.amendmentDto(ctx, id)),
        );
        return dtos;
      };
      return { ctx, domain, open, fresh };
    }

    it(
      "decides a bloc, reopens it whole, and records each delegation",
      { timeout: 120_000 },
      async () => {
        const { ctx, domain, open, fresh } = await setup();
        const candidates = (await fresh((await open()).map((row) => row.id)))
          .filter(
            (row) =>
              row.status === "submitted" &&
              row.admission === "admitted" &&
              row.publishedAt !== null &&
              row.kind !== "transactional",
          )
          .slice(0, 2);
        expect(candidates).toHaveLength(2);
        const items = candidates.map((row) => ({
          id: row.id,
          updatedAt: row.updatedAt,
        }));

        const carried = await domain.decideBlocVote(ctx, {
          items,
          vote: {
            method: "show_of_hands",
            inFavor: 10,
            against: 2,
            abstentions: 1,
          },
          project: false,
        });
        expect(carried.decision.kind).toBe("bloc");
        expect(carried.decision.vote?.blocAmendmentIds?.sort()).toEqual(
          items.map((item) => item.id).sort(),
        );
        expect(carried.amendments.map((row) => row.status)).toEqual([
          "approved",
          "approved",
        ]);

        // Reopening one without saying so is refused; with it, both reopen.
        const [first] = await fresh([items[0]!.id]);
        const reopenCtx = {
          ...ctx,
          amendment: await loadLoaded(first!.id),
          isAuthor: false,
        };
        await expect(
          domain.applyAmendmentOutcome(reopenCtx, {
            action: "reopen",
            updatedAt: first!.updatedAt,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await domain.applyAmendmentOutcome(reopenCtx, {
          action: "reopen",
          wholeVote: true,
          updatedAt: first!.updatedAt,
        });
        expect(
          (await fresh(items.map((item) => item.id))).map((r) => r.status),
        ).toEqual(["submitted", "submitted"]);

        // A registered bloc vote: the counts come from the ballots.
        const { resolveRollCallBallots } = await import("./headcounts");
        const voters = await resolveRollCallBallots(ctx.assembly.id, []);
        const ballots = voters.ballots.map((ballot, index) => ({
          memberId: ballot.memberId,
          choice:
            index % 3 === 0 ? ("against" as const) : ("in_favor" as const),
        }));
        const again = await fresh(items.map((item) => item.id));
        const registered = await domain.decideBlocVote(ctx, {
          items: again.map((row) => ({ id: row.id, updatedAt: row.updatedAt })),
          vote: {
            method: "roll_call",
            ballots,
            rollCallHeadcountId: voters.headcountId,
          },
          project: false,
        });
        const vote = registered.decision.vote!;
        expect(vote.ballots).toHaveLength(voters.ballots.length);
        expect(vote.inFavor + vote.against).toBe(voters.ballots.length);
        expect(vote.against).toBe(
          ballots.filter((b) => b.choice === "against").length,
        );

        // Reopen them for the next check.
        const [one] = await fresh([items[0]!.id]);
        await domain.applyAmendmentOutcome(
          { ...ctx, amendment: await loadLoaded(one!.id), isAuthor: false },
          { action: "reopen", wholeVote: true, updatedAt: one!.updatedAt },
        );

        // Between alternatives, keeping the winner undecided.
        const open2 = await fresh(items.map((item) => item.id));
        const alternatives = await domain.decideAlternatives(ctx, {
          method: "show_of_hands",
          options: [
            {
              items: [{ id: open2[0]!.id, updatedAt: open2[0]!.updatedAt }],
              count: 9,
            },
            {
              items: [{ id: open2[1]!.id, updatedAt: open2[1]!.updatedAt }],
              count: 3,
            },
          ],
          abstentions: 0,
          winnerOutcome: "keep",
          project: false,
        });
        expect(alternatives.amendments.map((row) => row.status)).toEqual([
          "submitted",
          "rejected",
        ]);
        const [loser] = await fresh([open2[1]!.id]);
        await domain.applyAmendmentOutcome(
          { ...ctx, amendment: await loadLoaded(loser!.id), isAuthor: false },
          { action: "reopen", wholeVote: true, updatedAt: loser!.updatedAt },
        );
        expect((await fresh([open2[1]!.id]))[0]!.status).toBe("submitted");
      },
    );
  },
);

async function loadLoaded(id: string) {
  const { findAmendmentsByIds } = await import("./amendments");
  const [row] = await findAmendmentsByIds([id]);
  return {
    ...row!,
  } as unknown as Parameters<
    (typeof import("./amendments"))["applyAmendmentOutcome"]
  >[0]["amendment"];
}

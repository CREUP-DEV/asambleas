import { afterAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "./actor";

/**
 * Opt-in check of the corrections of form to an approved text against a
 * real database, end to end through the domain:
 *
 *   FORMCORR_DB_TEST=1 FORMCORR_ASSEMBLY=80-ago FORMCORR_DOCUMENT=<slug> \
 *     pnpm exec vitest run server/utils/domain/formCorrections.db.test.ts
 *
 * The document must be structured, approved by its final vote, with a
 * user who presented it (`submitted_by_user_id`) and in an assembly that
 * is not closed (the last step annuls its final vote).
 *
 * IT WRITES: corrections, versions and events, and it annuls the final
 * vote. Dump the development database first and restore it after.
 * Skipped otherwise, and nothing touching the database is imported then.
 */
vi.mock("../auth/requireAuth", () => ({
  getAuthUserWithRole: vi.fn(),
  requireAuth: vi.fn(),
}));

const enabled = Boolean(process.env.FORMCORR_DB_TEST);

describe.skipIf(!enabled)(
  "corrections of form to an approved text, on the database",
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
      const admin = {
        user: { id: user!.id, name: user!.name, role: { name: "Admin" } },
        memberId: null,
        memberKind: null,
        isAdmin: true,
        permissions: [...ALL_PERMISSION_KEYS],
        can: () => true,
      } as unknown as Actor;
      const { resolveAssembly, resolveDocument } = await import("./resolvers");
      const assembly = await resolveAssembly(
        admin,
        process.env.FORMCORR_ASSEMBLY,
      );
      const found = await resolveDocument(
        admin,
        assembly.id,
        process.env.FORMCORR_DOCUMENT,
      );
      // Who presented it, with no permission of the Secretaría or the Mesa.
      const presenter = {
        user: {
          id: found.submittedByUserId!,
          name: "Presenter",
          role: { name: "Delegado" },
        },
        memberId: null,
        memberKind: null,
        isAdmin: false,
        permissions: [],
        can: () => false,
      } as unknown as Actor;
      const ctxOf = async (actor: Actor) => {
        const [row] = await db
          .select()
          .from(schema.documents)
          .where(eq(schema.documents.id, found.id));
        return {
          actor,
          assembly,
          document: { ...row!, coProponentMemberIds: [] },
        };
      };
      const currentVersion = async () => {
        const [row] = await db
          .select({ id: schema.documents.consolidatedVersionId })
          .from(schema.documents)
          .where(eq(schema.documents.id, found.id));
        const [version] = await db
          .select()
          .from(schema.documentVersions)
          .where(eq(schema.documentVersions.id, row!.id!));
        return version!;
      };
      /** The text with a mark added to its first paragraph. */
      const touched = (
        blocks: Awaited<ReturnType<typeof currentVersion>>["blocks"],
        mark: string,
      ) => {
        const index = blocks.findIndex((block) => block.type === "paragraph");
        return blocks.map((block, at) =>
          at === index ? { ...block, text: `${block.text}${mark}` } : block,
        );
      };
      return {
        admin,
        presenter,
        ctxOf,
        currentVersion,
        touched,
        domain: await import("./formCorrections"),
        documents: await import("./documents"),
      };
    }

    it(
      "applies, proposes, refuses stale ones and voids on annulment",
      { timeout: 120_000 },
      async () => {
        const s = await setup();
        const voted = await s.currentVersion();
        const rejected = (promise: Promise<unknown>) =>
          promise.then(
            () => null,
            (error: { statusCode?: number }) => error.statusCode ?? -1,
          );

        // The Mesa or the Secretaría: applied at once.
        const direct = await s.domain.createFormCorrection(
          await s.ctxOf(s.admin),
          {
            fromVersionId: voted.id,
            blocks: s.touched(voted.blocks, " [a]"),
            reason: "Errata",
          },
        );
        const afterDirect = await s.currentVersion();
        expect(afterDirect.id).not.toBe(voted.id);
        expect(afterDirect.replacesVersionId).toBe(voted.id);
        expect(afterDirect.note).toBe("Errata");
        expect(direct.votedVersionId).toBe(voted.id);
        expect(direct.corrections.at(-1)?.status).toBe("applied");

        // Made on a text no longer in force, or with no change.
        expect(
          await rejected(
            s.domain.createFormCorrection(await s.ctxOf(s.admin), {
              fromVersionId: voted.id,
              blocks: s.touched(voted.blocks, " [b]"),
              reason: "Tarde",
            }),
          ),
        ).toBe(409);
        expect(
          await rejected(
            s.domain.createFormCorrection(await s.ctxOf(s.admin), {
              fromVersionId: afterDirect.id,
              blocks: afterDirect.blocks,
              reason: "Nada",
            }),
          ),
        ).toBe(422);

        // A presenter's proposal waits; the Secretaría applies it.
        const proposed = await s.domain.createFormCorrection(
          await s.ctxOf(s.presenter),
          {
            fromVersionId: afterDirect.id,
            blocks: s.touched(afterDirect.blocks, " [c]"),
            reason: "Propuesta",
          },
        );
        const proposal = proposed.corrections.at(-1)!;
        expect(proposal.status).toBe("pending");
        expect((await s.currentVersion()).id).toBe(afterDirect.id);
        // Nobody but the Secretaría decides it.
        expect(
          await rejected(
            s.domain.decideFormCorrection(
              await s.ctxOf(s.presenter),
              proposal.id,
              { decision: "apply", updatedAt: proposal.updatedAt },
            ),
          ),
        ).toBe(403);
        const applied = await s.domain.decideFormCorrection(
          await s.ctxOf(s.admin),
          proposal.id,
          { decision: "apply", updatedAt: proposal.updatedAt },
        );
        expect(
          applied.corrections.find((c) => c.id === proposal.id)?.status,
        ).toBe("applied");
        const afterProposal = await s.currentVersion();
        expect(afterProposal.replacesVersionId).toBe(afterDirect.id);

        // A proposal another correction overtook cannot be applied.
        const second = (
          await s.domain.createFormCorrection(await s.ctxOf(s.presenter), {
            fromVersionId: afterProposal.id,
            blocks: s.touched(afterProposal.blocks, " [d]"),
            reason: "Otra",
          })
        ).corrections.at(-1)!;
        await s.domain.createFormCorrection(await s.ctxOf(s.admin), {
          fromVersionId: afterProposal.id,
          blocks: s.touched(afterProposal.blocks, " [e]"),
          reason: "Antes",
        });
        const listed = await s.domain.listFormCorrections(
          await s.ctxOf(s.admin),
        );
        const overtaken = listed.corrections.find((c) => c.id === second.id)!;
        expect(overtaken.onCurrentText).toBe(false);
        expect(overtaken.can.apply).toBe(false);
        expect(
          await rejected(
            s.domain.decideFormCorrection(await s.ctxOf(s.admin), second.id, {
              decision: "apply",
              updatedAt: overtaken.updatedAt,
            }),
          ),
        ).toBe(409);
        const afterReject = await s.domain.decideFormCorrection(
          await s.ctxOf(s.admin),
          second.id,
          {
            decision: "reject",
            note: "Ya corregido",
            updatedAt: overtaken.updatedAt,
          },
        );
        expect(
          afterReject.corrections.find((c) => c.id === second.id),
        ).toMatchObject({ status: "rejected", decisionNote: "Ya corregido" });

        // Its author withdraws one.
        const current = await s.currentVersion();
        const third = (
          await s.domain.createFormCorrection(await s.ctxOf(s.presenter), {
            fromVersionId: current.id,
            blocks: s.touched(current.blocks, " [f]"),
            reason: "Retirar",
          })
        ).corrections.at(-1)!;
        const withdrawn = await s.domain.withdrawFormCorrection(
          await s.ctxOf(s.presenter),
          third.id,
          { updatedAt: third.updatedAt },
        );
        expect(
          withdrawn.corrections.find((c) => c.id === third.id)?.status,
        ).toBe("withdrawn");

        // Annulling the final vote voids the ones still waiting.
        const fourth = (
          await s.domain.createFormCorrection(await s.ctxOf(s.presenter), {
            fromVersionId: current.id,
            blocks: s.touched(current.blocks, " [g]"),
            reason: "Pendiente",
          })
        ).corrections.at(-1)!;
        const ctx = await s.ctxOf(s.admin);
        await s.documents.annulFinalVote(ctx, {
          updatedAt: ctx.document.updatedAt.toISOString(),
          note: null,
        });
        const after = await s.domain.listFormCorrections(
          await s.ctxOf(s.admin),
        );
        expect(after.corrections.find((c) => c.id === fourth.id)?.status).toBe(
          "void",
        );
        expect(after.votedVersionId).toBeNull();
      },
    );
  },
);

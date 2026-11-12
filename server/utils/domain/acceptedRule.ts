import { and, asc, eq, inArray } from "drizzle-orm";
import type { db } from "../../db";
import {
  amendmentAcceptances,
  amendmentPositions,
  amendmentSources,
  amendments,
} from "../../db/schema";
import type { AcceptedAmendmentRule } from "~~/shared/constants/domain";
import type { Actor } from "./actor";
import { recordEvent } from "./events";
import { acceptedRulePlan, authorsApproval } from "./reviewState";
import {
  closeTransactionalsOver,
  competingTransactionalIds,
  loadSourceMap,
  reopenTransactionalsClosedBy,
  restoreLockIds,
  transactionalsOverIds,
} from "./transactionalClosure";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Applies a document's new rule for accepted amendments
 * (documents.acceptedAmendments) to the amendments its main presenter
 * already answered (acceptedRulePlan, docs/api.md "Documents"):
 * - to "incorporate", the accepted ones it could answer now are approved
 *   at once (approval method "proponent", amendment_approved with reason
 *   "rule_changed" and the main presenter as `memberId`), which closes the
 *   pending transactionals over them (closeTransactionalsOver);
 * - to "vote", the ones its acceptance approved go back to undecided
 *   (amendment_reopened with reason "rule_changed"), keeping the answer,
 *   and the transactionals their incorporation closed come back
 *   (reopenTransactionalsClosedBy).
 * The caller holds the document NO KEY UPDATE (updateDocument), which every
 * amendment path waits for (they take it FOR SHARE), and refuses the change
 * after the final vote. The amendment rows (with the transactionals over
 * them and, when they go back, what those group) are locked in id order,
 * then the acceptances ("Row locks").
 */
export async function applyAcceptedAmendmentsRule(
  tx: Tx,
  input: {
    assemblyId: string;
    documentId: string;
    rule: AcceptedAmendmentRule;
    /** The document's main presenter, whose acceptance is applied. */
    mainPresenterId: string | null;
    actor: Actor;
    now: Date;
  },
): Promise<void> {
  const candidates = await tx
    .select({ id: amendments.id })
    .from(amendments)
    .leftJoin(
      amendmentPositions,
      eq(amendmentPositions.amendmentId, amendments.id),
    )
    .where(
      and(
        eq(amendments.documentId, input.documentId),
        input.rule === "incorporate"
          ? and(
              eq(amendments.status, "submitted"),
              eq(amendmentPositions.position, "accept"),
            )
          : and(
              eq(amendments.status, "approved"),
              eq(amendments.approvalMethod, "proponent"),
            ),
      ),
    );
  if (candidates.length === 0) return;
  const ids = candidates.map((row) => row.id);
  // Incorporating them closes the transactionals over them, and taking
  // them out again brings back the ones that closed: locked in the same
  // ordered pass, with what those group when they may come back.
  const sourceMap = await loadSourceMap(tx, input.documentId);
  const dependentIds = competingTransactionalIds(sourceMap, null, ids).filter(
    (id) => !ids.includes(id),
  );
  const restoreIds =
    input.rule === "vote" ? restoreLockIds(sourceMap, ids) : [];
  const overIds =
    input.rule === "vote" ? transactionalsOverIds(sourceMap, ids) : [];

  const lockedAll = await tx
    .select({
      id: amendments.id,
      code: amendments.code,
      kind: amendments.kind,
      status: amendments.status,
      admission: amendments.admission,
      validatedAt: amendments.validatedAt,
      publishedAt: amendments.publishedAt,
      decidedAt: amendments.decidedAt,
      approvalMethod: amendments.approvalMethod,
    })
    .from(amendments)
    .where(
      inArray(amendments.id, [
        ...new Set([...ids, ...dependentIds, ...restoreIds]),
      ]),
    )
    .orderBy(asc(amendments.id))
    .for("no key update");
  const locked = lockedAll.filter((row) => ids.includes(row.id));
  const transactionalIds = locked
    .filter((row) => row.kind === "transactional")
    .map((row) => row.id);
  // Theirs and, when they go back, those of the transactionals over them.
  const partyIds = [...new Set([...transactionalIds, ...overIds])];
  const [parties, positions, sources] = await Promise.all([
    partyIds.length > 0
      ? tx
          .select({
            amendmentId: amendmentAcceptances.amendmentId,
            role: amendmentAcceptances.role,
            decision: amendmentAcceptances.decision,
          })
          .from(amendmentAcceptances)
          .where(inArray(amendmentAcceptances.amendmentId, partyIds))
          .orderBy(asc(amendmentAcceptances.id))
          .for("share")
      : Promise.resolve([]),
    tx
      .select({
        amendmentId: amendmentPositions.amendmentId,
        position: amendmentPositions.position,
      })
      .from(amendmentPositions)
      .where(inArray(amendmentPositions.amendmentId, ids)),
    // A transactional presented under the earlier rule replaced its sources
    // only on approval: while one is still open the Mesa approves it.
    transactionalIds.length > 0
      ? tx
          .select({ transactionalId: amendmentSources.transactionalId })
          .from(amendmentSources)
          .innerJoin(amendments, eq(amendments.id, amendmentSources.sourceId))
          .where(
            and(
              inArray(amendmentSources.transactionalId, transactionalIds),
              eq(amendments.status, "submitted"),
            ),
          )
      : Promise.resolve([]),
  ]);
  const positionOf = new Map(
    positions.map((row) => [row.amendmentId, row.position]),
  );
  const keepsSources = new Set(sources.map((row) => row.transactionalId));

  const plan = acceptedRulePlan(
    locked.map((row) => ({
      ...row,
      authorsApproval: authorsApproval({
        kind: row.kind,
        acceptances: parties.filter((party) => party.amendmentId === row.id),
      }),
      position: positionOf.get(row.id) ?? null,
      keepsSources: keepsSources.has(row.id),
    })),
    input.rule,
  );

  const base = {
    assemblyId: input.assemblyId,
    documentId: input.documentId,
    entityType: "amendment" as const,
    actor: input.actor,
  };
  if (plan.approve.length > 0) {
    const approved = await tx
      .update(amendments)
      .set({
        status: "approved",
        approvalMethod: "proponent",
        outcomeVoteId: null,
        outcomeNote: null,
        decidedAt: input.now,
      })
      .where(
        and(
          inArray(amendments.id, plan.approve),
          eq(amendments.status, "submitted"),
          eq(amendments.admission, "admitted"),
        ),
      )
      .returning({ id: amendments.id });
    for (const row of approved) {
      await recordEvent(tx, {
        ...base,
        entityId: row.id,
        type: "amendment_approved",
        payload: {
          method: "proponent",
          reason: "rule_changed",
          memberId: input.mainPresenterId,
        },
      });
    }
    const approvedIds = new Set(approved.map((row) => row.id));
    await closeTransactionalsOver(tx, {
      assemblyId: input.assemblyId,
      documentId: input.documentId,
      actor: input.actor,
      now: input.now,
      sourceMap,
      closed: locked
        .filter((row) => approvedIds.has(row.id))
        .map((row) => ({
          id: row.id,
          code: row.code,
          status: "approved" as const,
        })),
      candidates: lockedAll.filter((row) => dependentIds.includes(row.id)),
    });
  }
  if (plan.reopen.length > 0) {
    const reopened = await tx
      .update(amendments)
      .set({
        status: "submitted",
        approvalMethod: null,
        outcomeNote: null,
        decidedAt: null,
      })
      .where(
        and(
          inArray(amendments.id, plan.reopen),
          eq(amendments.status, "approved"),
          eq(amendments.approvalMethod, "proponent"),
        ),
      )
      .returning({ id: amendments.id });
    for (const row of reopened) {
      await recordEvent(tx, {
        ...base,
        entityId: row.id,
        type: "amendment_reopened",
        payload: { previousStatus: "approved", reason: "rule_changed" },
      });
    }
    const reopenedIds = new Set(reopened.map((row) => row.id));
    const back = locked.filter((row) => reopenedIds.has(row.id));
    await reopenTransactionalsClosedBy(tx, {
      assemblyId: input.assemblyId,
      documentId: input.documentId,
      actor: input.actor,
      sourceMap,
      reopened: back.map((row) => ({ id: row.id, code: row.code })),
      locked: lockedAll,
      parties,
    });
  }
}

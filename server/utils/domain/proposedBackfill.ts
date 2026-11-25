import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  amendmentPositions,
  amendments,
  assemblies,
  documents,
  events,
} from "../../db/schema";
import { logError, logInfo } from "../core/logger";
import { loadActorForUser } from "./actor";
import {
  buildDocumentAmendmentContext,
  settleProposedTransactionals,
  type StoredAmendmentMeta,
} from "./amendments";
import { loadMilestones } from "./documents";
import { loadAnswersOnValidation } from "./executiveMembers";
import { withCoProponentIds } from "./presenters";
import { proposingPresenterOf } from "./reviewState";

/**
 * Marks, in `meta`, a transactional whose proposer backfillProposers filled:
 * presented before the release that stores it, so the only ones
 * backfillProposedTransactionals settles, and cleared once it has.
 */
const BACKFILLED = "proposerBackfilled";

/**
 * Who presented each transactional a member presented before that was
 * stored (`meta.proposerMemberId`): the member of the account behind its
 * latest `amendment_submitted`, when that presentation was a member's (it
 * waited for the Secretaría, `admission: "pending"`; the Mesa's in session
 * is admitted at once and has no proposer). Only rows without it, so a
 * second run writes nothing; the ones it fills are marked (BACKFILLED).
 * Returns how many it filled.
 */
async function backfillProposers(): Promise<number> {
  const result = await db.execute(sql`
    update ${amendments} as a
    set meta = coalesce(a.meta, '{}'::jsonb)
      || jsonb_build_object(
        'proposerMemberId', s.actor_member_id,
        ${BACKFILLED}::text, true
      )
    from (
      select distinct on (e.entity_id)
        e.entity_id, e.actor_member_id, e.payload
      from ${events} as e
      where e.entity_type = 'amendment' and e.type = 'amendment_submitted'
      order by e.entity_id, e.created_at desc, e.id desc
    ) as s
    where s.entity_id = a.id
      and a.kind = 'transactional'
      and a.status <> 'draft'
      and not (coalesce(a.meta, '{}'::jsonb) ? 'proposerMemberId')
      and s.actor_member_id is not null
      and s.payload->>'admission' = 'pending'
  `);
  return result.rowCount ?? 0;
}

/**
 * A transactional presented by a presenter of its document is accepted by
 * that presenter on presenting it (user's decision of 2026-11-21). The ones
 * presented before that rule (their proposer filled by backfillProposers,
 * BACKFILLED) get it once, at boot: presented and undecided, validated, in
 * an assembly that is not closed and a document not voted, its proposer a
 * presenter of the document now, with no answer and no `position_changed`
 * ever (an answer someone set back to pending is a choice, never
 * overridden). Each one goes through settleProposedTransactionals, which
 * checks it again under the locks and records the answer as that
 * presenter's (`reason: "proposed"`), with the account that validated it as
 * the actor. Then the marks go, so a later boot settles nothing: what
 * happens afterwards (a parent declared not admitted, a proposer named a
 * co-presenter after the validation) is answered when it happens, never by
 * a restart. One presented since the release stores its proposer itself
 * and is never marked.
 */
export async function backfillProposedTransactionals(): Promise<void> {
  const filled = await backfillProposers();
  const answered = db
    .select({ id: events.entityId })
    .from(events)
    .where(
      and(
        eq(events.entityType, "amendment"),
        eq(events.type, "position_changed"),
      ),
    );
  const candidates = await db
    .select({
      id: amendments.id,
      documentId: amendments.documentId,
      meta: amendments.meta,
      validatedByUserId: amendments.validatedByUserId,
    })
    .from(amendments)
    .innerJoin(documents, eq(documents.id, amendments.documentId))
    .innerJoin(assemblies, eq(assemblies.id, documents.assemblyId))
    .leftJoin(
      amendmentPositions,
      eq(amendmentPositions.amendmentId, amendments.id),
    )
    .where(
      and(
        eq(amendments.kind, "transactional"),
        eq(amendments.status, "submitted"),
        isNotNull(amendments.validatedAt),
        isNotNull(amendments.validatedByUserId),
        ne(assemblies.status, "closed"),
        isNull(documents.finalVoteId),
        isNull(documents.consolidatedVersionId),
        sql`coalesce(${amendmentPositions.position}::text, 'pending') = 'pending'`,
        sql`${amendments.id} not in (${answered})`,
        sql`${amendments.meta} ? 'proposerMemberId'`,
        sql`${amendments.meta} ? ${BACKFILLED}::text`,
      ),
    );
  try {
    await settleCandidates(candidates, filled);
  } finally {
    // Once only: whatever this run left is the presenter's to answer.
    await clearBackfillMarks();
  }
}

/** Removes the BACKFILLED mark from every transactional that has it. */
async function clearBackfillMarks(): Promise<number> {
  const result = await db.execute(sql`
    update ${amendments}
    set meta = meta - ${BACKFILLED}::text
    where meta ? ${BACKFILLED}::text
  `);
  return result.rowCount ?? 0;
}

async function settleCandidates(
  candidates: {
    id: string;
    documentId: string;
    meta: unknown;
    validatedByUserId: string | null;
  }[],
  filled: number,
): Promise<void> {
  if (candidates.length === 0) {
    if (filled > 0) {
      logInfo("amendments.proposed_backfill", { proposers: filled });
    }
    return;
  }

  // One pass per document and validator, who acts in it.
  const groups = new Map<
    string,
    { documentId: string; userId: string; rows: typeof candidates }
  >();
  for (const row of candidates) {
    const userId = row.validatedByUserId!;
    const key = `${row.documentId}:${userId}`;
    const group = groups.get(key) ?? {
      documentId: row.documentId,
      userId,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }

  let checked = 0;
  for (const group of groups.values()) {
    try {
      const [document] = await db.query.documents
        .findMany({ where: eq(documents.id, group.documentId) })
        .then((list) => withCoProponentIds(list));
      if (!document) continue;
      const presenterIds = [
        document.proponentMemberId,
        ...document.coProponentMemberIds,
      ];
      // Only the ones its own presenter presented: the rest wait for her.
      const ids = group.rows
        .filter(
          (row) =>
            proposingPresenterOf({
              kind: "transactional",
              proposerMemberId: (row.meta as StoredAmendmentMeta | null)
                ?.proposerMemberId,
              presenterIds,
            }) !== null,
        )
        .map((row) => row.id);
      if (ids.length === 0) continue;
      const actor = await loadActorForUser(group.userId);
      if (!actor) continue;
      const assembly = await db.query.assemblies.findFirst({
        where: eq(assemblies.id, document.assemblyId),
      });
      if (!assembly) continue;
      const ctx = buildDocumentAmendmentContext(
        actor,
        assembly,
        document,
        await loadMilestones(assembly.id),
        await loadAnswersOnValidation(document),
      );
      await settleProposedTransactionals(ctx, ids);
      checked += ids.length;
    } catch (error) {
      logError("amendments.proposed_backfill", error, {
        documentId: group.documentId,
      });
    }
  }
  logInfo("amendments.proposed_backfill", {
    proposers: filled,
    candidates: candidates.length,
    checked,
  });
}

import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  amendmentPositions,
  amendments,
  assemblies,
  documents,
  events,
} from "../../db/schema";
import { logError, logInfo } from "../core/logger";
import { loadExportActor } from "../export/actor";
import {
  acceptAnswerableFormalAmendments,
  buildDocumentAmendmentContext,
} from "./amendments";
import { loadMilestones } from "./documents";
import { loadAnswersOnValidation } from "./executiveMembers";
import { withCoProponentIds } from "./presenters";

/**
 * Formal amendments are accepted by themselves the moment they can be
 * answered. The ones that could be answered before that rule existed
 * (user's decision of 2026-11-17) get the same automatic acceptance once,
 * at boot: presented, undecided and validated, in an assembly that is not
 * closed, with no answer and no `position_changed` ever (an answer someone
 * set back to pending is a choice, never overridden). Each one goes through
 * acceptAnswerableFormalAmendments, which checks it can be answered now and
 * records what any automatic acceptance records, with the account that
 * validated it as the one who made it answerable. Running it again finds
 * nothing left.
 */
export async function backfillFormalAnswers(): Promise<void> {
  const answered = db
    .select({ id: events.entityId })
    .from(events)
    .where(
      and(
        eq(events.entityType, "amendment"),
        eq(events.type, "position_changed"),
      ),
    );
  const rows = await db
    .select({
      id: amendments.id,
      documentId: amendments.documentId,
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
        eq(amendments.kind, "formal"),
        eq(amendments.status, "submitted"),
        isNotNull(amendments.validatedAt),
        isNotNull(amendments.validatedByUserId),
        ne(assemblies.status, "closed"),
        sql`coalesce(${amendmentPositions.position}::text, 'pending') = 'pending'`,
        sql`${amendments.id} not in (${answered})`,
      ),
    );
  if (rows.length === 0) return;

  // One pass per document and validator, who acts in it.
  const groups = new Map<
    string,
    { documentId: string; userId: string; ids: string[] }
  >();
  for (const row of rows) {
    const userId = row.validatedByUserId!;
    const key = `${row.documentId}:${userId}`;
    const group = groups.get(key) ?? {
      documentId: row.documentId,
      userId,
      ids: [],
    };
    group.ids.push(row.id);
    groups.set(key, group);
  }

  let done = 0;
  for (const group of groups.values()) {
    try {
      const actor = await loadExportActor(group.userId);
      const [document] = await db.query.documents
        .findMany({ where: eq(documents.id, group.documentId) })
        .then((list) => withCoProponentIds(list));
      if (!actor || !document) continue;
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
      await acceptAnswerableFormalAmendments(ctx, group.ids);
      done += group.ids.length;
    } catch (error) {
      logError("amendments.formal_backfill", error, {
        documentId: group.documentId,
      });
    }
  }
  const accepted = await db
    .select({ id: amendmentPositions.amendmentId })
    .from(amendmentPositions)
    .where(
      and(
        inArray(
          amendmentPositions.amendmentId,
          rows.map((row) => row.id),
        ),
        eq(amendmentPositions.position, "accept"),
      ),
    );
  logInfo("amendments.formal_backfill", {
    candidates: rows.length,
    checked: done,
    accepted: accepted.length,
  });
}

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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
  settleFormalAmendments,
} from "./amendments";
import { loadMilestones } from "./documents";
import { loadAnswersOnValidation } from "./executiveMembers";
import { withCoProponentIds } from "./presenters";

/**
 * Formal amendments are accepted by themselves the moment they can be
 * answered (user's decision of 2026-11-17), published when validated and
 * incorporated by that acceptance whatever the document's rule (user's
 * decision of 2026-11-20). The ones validated before those rules get the
 * same once, at boot: presented and undecided, validated, in an assembly
 * that is not closed and a document not voted, and still private, or with
 * no answer and no `position_changed` ever (an answer someone set back to
 * pending is a choice, never overridden), or admitted with an acceptance.
 * Each one goes through settleFormalAmendments, which checks each step
 * again and records what the validation would have, with the account that
 * validated it as the one who made it answerable. A rejected one stays as
 * it is. Running it again finds nothing left.
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
        isNull(documents.finalVoteId),
        isNull(documents.consolidatedVersionId),
        or(
          isNull(amendments.publishedAt),
          and(
            sql`coalesce(${amendmentPositions.position}::text, 'pending') = 'pending'`,
            sql`${amendments.id} not in (${answered})`,
          ),
          and(
            eq(amendments.admission, "admitted"),
            eq(amendmentPositions.position, "accept"),
          ),
        ),
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
      const actor = await loadActorForUser(group.userId);
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
      await settleFormalAmendments(ctx, group.ids);
      done += group.ids.length;
    } catch (error) {
      logError("amendments.formal_backfill", error, {
        documentId: group.documentId,
      });
    }
  }
  const incorporated = await db
    .select({ id: amendments.id })
    .from(amendments)
    .where(
      and(
        inArray(
          amendments.id,
          rows.map((row) => row.id),
        ),
        eq(amendments.status, "approved"),
      ),
    );
  logInfo("amendments.formal_backfill", {
    candidates: rows.length,
    checked: done,
    incorporated: incorporated.length,
  });
}

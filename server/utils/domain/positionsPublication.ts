import { and, eq, isNull, or } from "drizzle-orm";
import { assemblies, documents } from "../../db/schema";
import type { Actor } from "./actor";
import { recordEvent, type Executor } from "./events";

/**
 * Marks that the debate of what the Mesa puts in debate has started: the
 * published documents of that agenda item, and the document itself when
 * one is chosen, get `positions_debate_started_at` once, so the main
 * presenter's answers to their amendments are public from then on, for
 * good (positionsArePublic). Only while the assembly is in session: the
 * Mesa trying the console before it publishes nothing. Called by every
 * writer of live_state that points it at an item or a document, inside its
 * transaction and after its assembly lock; records
 * `document_positions_debate_started` for each document it marks (whose
 * actor only moved the projection: nobody chose to publish), so open
 * clients refetch.
 */
export async function stampDebateStarted(
  tx: Executor,
  input: {
    assemblyId: string;
    agendaItemId: string | null;
    documentId: string | null;
    actor: Actor;
  },
): Promise<void> {
  const targets = [
    input.agendaItemId ? eq(documents.agendaItemId, input.agendaItemId) : null,
    input.documentId ? eq(documents.id, input.documentId) : null,
  ].filter((condition) => condition !== null);
  if (targets.length === 0) return;
  const [assembly] = await tx
    .select({ status: assemblies.status })
    .from(assemblies)
    .where(eq(assemblies.id, input.assemblyId));
  if (assembly?.status !== "in_session") return;

  const stamped = await tx
    .update(documents)
    .set({ positionsDebateStartedAt: new Date() })
    .where(
      and(
        eq(documents.assemblyId, input.assemblyId),
        eq(documents.status, "published"),
        isNull(documents.positionsDebateStartedAt),
        or(...targets),
      ),
    )
    .returning({
      id: documents.id,
      positionsPublishedAt: documents.positionsPublishedAt,
    });
  for (const document of stamped) {
    await recordEvent(tx, {
      assemblyId: input.assemblyId,
      entityType: "document",
      entityId: document.id,
      documentId: document.id,
      type: "document_positions_debate_started",
      payload: { alreadyPublic: document.positionsPublishedAt !== null },
      actor: input.actor,
    });
  }
}

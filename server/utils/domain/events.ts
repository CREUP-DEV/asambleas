import { sql } from "drizzle-orm";
import type { db } from "../../db";
import { events } from "../../db/schema";
import type { Actor } from "./actor";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const LIVE_CHANNEL = "assembly_events";

export type EntityType =
  | "assembly"
  | "agenda_item"
  | "document"
  | "amendment"
  | "vote"
  | "decision"
  | "live"
  /** Speaking turns: entityId is the turn, or the assembly for visibility. */
  | "speakers";

export interface LiveMessage {
  assemblyId: string;
  entityType: EntityType;
  entityId: string;
  type: string;
  /** Present for document-scoped changes, so clients refresh only what changed. */
  documentId?: string;
}

/**
 * Appends an event to the history and notifies live listeners. Inside a
 * transaction the notification is delivered on commit, so clients never see
 * a change that was rolled back. Notifications carry ids only: clients refetch
 * through the normal, permission-checked endpoints.
 */
export async function recordEvent(
  executor: Executor,
  input: LiveMessage & {
    payload?: Record<string, unknown>;
    actor?: Actor | null;
  },
): Promise<void> {
  await executor.insert(events).values({
    assemblyId: input.assemblyId,
    entityType: input.entityType,
    entityId: input.entityId,
    type: input.type,
    payload: input.payload ?? {},
    actorUserId: input.actor?.user.id ?? null,
    actorMemberId: input.actor?.memberId ?? null,
  });

  const message: LiveMessage = {
    assemblyId: input.assemblyId,
    entityType: input.entityType,
    entityId: input.entityId,
    type: input.type,
    ...(input.documentId ? { documentId: input.documentId } : {}),
  };
  await executor.execute(
    sql`select pg_notify(${LIVE_CHANNEL}, ${JSON.stringify(message)})`,
  );
}

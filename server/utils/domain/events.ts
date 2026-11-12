import { sql } from "drizzle-orm";
import type { db } from "../../db";
import { cuid, events, notificationOutbox } from "../../db/schema";
import { eventMayNotify } from "../notifications/triggers";
import type { Actor } from "./actor";

/** The database or an open transaction: what recordEvent and recordAudit write through. */
export type Executor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  | "speakers"
  /** The Mesa's headcounts: entityId is the count. */
  | "headcount";

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
 *
 * The time is the insert's own (`clock_timestamp()`), not the transaction's
 * start (`now()`, the column default): events recorded in one transaction
 * then keep the order the code records them in, cause before effect, since
 * histories sort by time and the random id only breaks exact ties.
 *
 * While an Admin acts as another account, the actor is that account and
 * `impersonation_id` names the impersonation (eventImpersonationId), so the
 * real Admin and the time window stay on record.
 *
 * An event that may send an email (eventMayNotify) also goes to
 * notification_outbox in the same transaction.
 */
export async function recordEvent(
  executor: Executor,
  input: LiveMessage & {
    payload?: Record<string, unknown>;
    actor?: Actor | null;
    /**
     * The impersonation behind an event recorded with `actor: null` inside
     * an impersonated request (a transactional closed as a side effect, for
     * example). Defaults to the actor's.
     */
    impersonationId?: string | null;
  },
): Promise<void> {
  const id = cuid();
  await executor.insert(events).values({
    id,
    assemblyId: input.assemblyId,
    entityType: input.entityType,
    entityId: input.entityId,
    type: input.type,
    payload: input.payload ?? {},
    actorUserId: input.actor?.user.id ?? null,
    actorMemberId: input.actor?.memberId ?? null,
    impersonationId: eventImpersonationId(input),
    createdAt: sql`clock_timestamp()`,
  });
  // The email notifications read it once the change commits; a rollback
  // takes it away with the event (server/utils/notifications/*).
  if (eventMayNotify(input.type, input.payload)) {
    await executor.insert(notificationOutbox).values({ eventId: id });
  }

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

/**
 * The impersonation an event is recorded under: the explicit one when
 * given, otherwise the actor's, otherwise none.
 */
export function eventImpersonationId(input: {
  actor?: Pick<Actor, "impersonation"> | null;
  impersonationId?: string | null;
}): string | null {
  return input.impersonationId ?? input.actor?.impersonation?.id ?? null;
}

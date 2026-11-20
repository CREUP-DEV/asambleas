import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { db } from "../../db";
import { cuid, events, notificationOutbox } from "../../db/schema";
import { logWarn } from "../core/logger";
import { eventMayNotify } from "../notifications/triggers";
import { liveAudienceOf, type LiveAudience } from "../live/audience";
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
  | "headcount"
  /**
   * The control sheet: entityId is the sheet row (control_sheet_items or
   * control_sheet_amendments), the item or amendment in payload.subjectId.
   */
  | "control_sheet"
  /**
   * The room (Sala): entityId is the seating plan; the group, the person or
   * the counts in the payload, never a name.
   */
  | "seating"
  /**
   * Control of the projection passed to another session console
   * (projection_control_changed): entityId is the assembly. The Mesa's.
   */
  | "projection";

export interface LiveMessage {
  assemblyId: string;
  entityType: EntityType;
  entityId: string;
  type: string;
  /** Present for document-scoped changes, so clients refresh only what changed. */
  documentId?: string;
  /**
   * Who the SSE streams tell, when not everyone sees the amendment it is
   * about (server/utils/live/audience.ts); absent means everyone. Set by
   * recordEvent, never sent to clients (toLiveEventDto).
   */
  audience?: LiveAudience;
}

/** The NOTIFY payload limit is 8000 bytes; an audience never risks it. */
const MAX_NOTICE_BYTES = 7_500;

/**
 * Appends an event to the history and notifies live listeners. Inside a
 * transaction the notification is delivered on commit, so clients never see
 * a change that was rolled back; inside holdLiveNotices it waits for the
 * caller to send it with the rest (a bloc approved by assent). Notifications
 * carry ids only: clients refetch through the normal, permission-checked
 * endpoints.
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
 *
 * An amendment event about what the room may not see (a draft, a
 * presented amendment not published) names its audience in the live
 * notice (liveAudienceOf, read here in the same transaction, after the
 * caller's own write), so the SSE streams of everyone else skip it
 * (liveMessageReaches); the email runner still hears every event.
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

  const audience = await liveAudienceOf(executor, input);
  await notifyLive(executor, audience ? { ...input, audience } : input);
}

/**
 * Tells live listeners that something changed, without a history row: for
 * what is not a change anyone made, such as a cached image of the seating
 * view arriving (server/utils/seating/images.ts). Ids only, like every live
 * message. recordEvent calls it for every event.
 */
export async function notifyLive(
  executor: Executor,
  input: LiveMessage,
): Promise<void> {
  const message = liveNotice(input);
  const held = heldNotices.getStore();
  if (held) {
    held.push(message);
    return;
  }
  await executor.execute(
    sql`select pg_notify(${LIVE_CHANNEL}, ${JSON.stringify(message)})`,
  );
}

/**
 * The live notice of `input`: its ids and, when it has one, its audience,
 * left out (everyone is told) should it make the notice too long.
 */
export function liveNotice(input: LiveMessage): LiveMessage {
  const message: LiveMessage = {
    assemblyId: input.assemblyId,
    entityType: input.entityType,
    entityId: input.entityId,
    type: input.type,
    ...(input.documentId ? { documentId: input.documentId } : {}),
  };
  if (!input.audience) return message;
  const withAudience = { ...message, audience: input.audience };
  return JSON.stringify(withAudience).length > MAX_NOTICE_BYTES
    ? message
    : withAudience;
}

/** The live notices held back by the holdLiveNotices around this call. */
const heldNotices = new AsyncLocalStorage<LiveMessage[]>();

/**
 * Runs `run` holding back the live notices of what it records: notifyLive
 * (and so recordEvent, also in the helpers it calls) puts each message in
 * `held` instead of notifying, while the history row and the outbox entry
 * are written in their transaction as usual. The caller sends them with
 * sendLiveNotices once its work is over, so a request that commits several
 * changes one after another (a bloc approved by assent, several amendments
 * lapsed) reaches the room as one batch instead of one refetch per change:
 * with commits 50-100 ms apart, the clients' debounce kept restarting and
 * the room refetched in the middle of the bloc. The scope follows the async
 * calls of `run` only, never another request; nothing on the outcome path
 * notifies from work left running after `run` (a timer, an unawaited
 * promise), which would land in a list already sent.
 */
export function holdLiveNotices<T>(
  held: LiveMessage[],
  run: () => Promise<T>,
): Promise<T> {
  return heldNotices.run(held, run);
}

/**
 * Sends held live notices (holdLiveNotices) in one statement, so they reach
 * the listeners together; a repeated one goes once. Should that statement
 * fail, they go one by one, as notifyLive sends them. Call it after the
 * changes they announce have committed, never inside their transaction.
 */
export async function sendLiveNotices(
  executor: Executor,
  messages: readonly LiveMessage[],
): Promise<void> {
  const payloads = [
    ...new Set(messages.map((message) => JSON.stringify(message))),
  ];
  if (payloads.length === 0) return;
  try {
    // json_array_elements_text names its column `value`.
    await executor.execute(
      sql`select pg_notify(${LIVE_CHANNEL}, value) from json_array_elements_text(${JSON.stringify(payloads)}::json)`,
    );
  } catch (error) {
    logWarn("events.sendLiveNotices", {
      reason: "batch failed, sending one by one",
      error: String(error),
    });
    for (const payload of payloads) {
      await executor.execute(
        sql`select pg_notify(${LIVE_CHANNEL}, ${payload})`,
      );
    }
  }
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

import type { H3Event } from "h3";
import { getRequestHeader, getRequestIP } from "h3";
import { sql } from "drizzle-orm";
import { auditLog } from "../../db/schema";
import type { Executor } from "./events";
import type {
  AuditAction,
  AuditSource,
  AuditTargetType,
} from "~~/shared/constants/activity";

export const AUDIT_IP_MAX_LENGTH = 64;
export const AUDIT_USER_AGENT_MAX_LENGTH = 512;

/**
 * Who did it, in any of the shapes the callers hold:
 * - requireActor's `Actor` or requireAnyPermission's / requireAdmin's
 *   `AdminCaller` (`user.id` plus their `impersonation`);
 * - an explicit reference, for writers without a request actor: an auth
 *   hook names the user signing in, an impersonation's own rows name the
 *   real Admin.
 */
export type AuditActorInput =
  | { user: { id: string }; impersonation?: { id: string } | null }
  | { userId: string | null; impersonationId?: string | null };

export interface RecordAuditInput {
  /**
   * The request. Gives the IP and the user agent and, when `actor` is
   * omitted, the actor: the effective user and the impersonation that
   * getAuthUserWithRole put on event.context.
   */
  event?: H3Event | null;
  /**
   * Who did it. Omitted: taken from `event` (null without one). null: nobody
   * (the intranet, the seed, the system).
   */
  actor?: AuditActorInput | null;
  /** Overrides the actor's impersonation (undefined keeps it). */
  impersonationId?: string | null;
  /** Defaults to "user". */
  source?: AuditSource;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  /** The assembly it concerns, for the activity filters. */
  assemblyId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Overrides the request's IP (writers without an H3Event: auth hooks). */
  ipAddress?: string | null;
  /** Overrides the request's user agent. */
  userAgent?: string | null;
  /**
   * Write the row even when `before` and `after` are both given and equal.
   * By default such a no-op is skipped.
   */
  recordUnchanged?: boolean;
}

/** The actor and impersonation of an audit row. */
export interface AuditActorRef {
  userId: string | null;
  impersonationId: string | null;
}

interface ContextIdentity {
  user?: { id: string } | null;
  impersonation?: { id: string } | null;
}

/**
 * The actor of the current request as audit rows and job data record it:
 * the effective user (the account acted as, while impersonating) and the
 * impersonation. Both null before getAuthUserWithRole ran.
 */
export function requestActorRef(
  event: H3Event | null | undefined,
): AuditActorRef {
  const context = (event?.context ?? {}) as ContextIdentity;
  return {
    userId: context.user?.id ?? null,
    impersonationId: context.impersonation?.id ?? null,
  };
}

/** Resolves the actor of an audit row from recordAudit's input. */
export function resolveAuditActor(input: {
  event?: H3Event | null;
  actor?: AuditActorInput | null;
  impersonationId?: string | null;
}): AuditActorRef {
  let ref: AuditActorRef;
  if (input.actor === undefined) {
    ref = requestActorRef(input.event);
  } else if (input.actor === null) {
    ref = { userId: null, impersonationId: null };
  } else if ("user" in input.actor) {
    ref = {
      userId: input.actor.user.id,
      impersonationId: input.actor.impersonation?.id ?? null,
    };
  } else {
    ref = {
      userId: input.actor.userId,
      impersonationId: input.actor.impersonationId ?? null,
    };
  }
  if (input.impersonationId !== undefined) {
    ref = { ...ref, impersonationId: input.impersonationId };
  }
  return ref;
}

function truncate(value: string | null | undefined, max: number) {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
}

/**
 * The client of a request: the IP (X-Forwarded-For first, since the app
 * runs behind a proxy) and the user agent, truncated.
 */
export function requestClientInfo(event: H3Event | null | undefined): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  if (!event) return { ipAddress: null, userAgent: null };
  return {
    ipAddress: truncate(
      getRequestIP(event, { xForwardedFor: true }),
      AUDIT_IP_MAX_LENGTH,
    ),
    userAgent: truncate(
      getRequestHeader(event, "user-agent"),
      AUDIT_USER_AGENT_MAX_LENGTH,
    ),
  };
}

/** JSON with sorted object keys, so equal values compare equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return inner;
  });
}

/** A change that changes nothing: both sides given and equal. */
export function isUnchangedAudit(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  if (!before || !after) return false;
  return stableJson(before) === stableJson(after);
}

/**
 * Appends a row to audit_log: the only writer allowed (a test rejects
 * `insert(auditLog)` anywhere else). It fills the actor and the
 * impersonation (from the request unless given), the IP and the user agent,
 * and records the insert's own time (`clock_timestamp()`), so rows written
 * in one transaction keep their order. Inside a transaction it commits or
 * rolls back with the change it records.
 *
 * Returns the new row's id, or null when it skipped a no-op (`before` and
 * `after` both given and equal, unless `recordUnchanged`).
 */
export async function recordAudit(
  executor: Executor,
  input: RecordAuditInput,
): Promise<string | null> {
  const before = input.before ?? null;
  const after = input.after ?? null;
  if (!input.recordUnchanged && isUnchangedAudit(before, after)) {
    return null;
  }

  const actor = resolveAuditActor(input);
  const client = requestClientInfo(input.event);
  const [row] = await executor
    .insert(auditLog)
    .values({
      actorUserId: actor.userId,
      impersonationId: actor.impersonationId,
      source: input.source ?? "user",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      assemblyId: input.assemblyId ?? null,
      before,
      after,
      ipAddress:
        input.ipAddress !== undefined
          ? truncate(input.ipAddress, AUDIT_IP_MAX_LENGTH)
          : client.ipAddress,
      userAgent:
        input.userAgent !== undefined
          ? truncate(input.userAgent, AUDIT_USER_AGENT_MAX_LENGTH)
          : client.userAgent,
      createdAt: sql`clock_timestamp()`,
    })
    .returning({ id: auditLog.id });
  return row?.id ?? null;
}

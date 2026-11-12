import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { documents, roles, users } from "../../db/schema";
import { findAmendmentsByIds } from "../domain/amendments";
import type { Executor } from "../domain/events";
import { loadCoProponentIds } from "../domain/presenters";
import {
  NOTIFICATION_AUDIENCE,
  type NotificationFrequency,
  type NotificationKind,
  type NotificationSettings,
} from "~~/shared/constants/notifications";
import { noticesForEvent, type NotifyingEvent, type PlanFacts } from "./rules";

export type { NotifyingEvent } from "./rules";

/**
 * Who gets which notice for one committed event (docs/design.md, "Email
 * notifications"). `noticesForEvent` (./rules.ts) is the rule, pure;
 * `planDeliveries` loads what it needs and turns notices into one row per
 * account.
 *
 * Nobody is told about their own act: the account that did it never, and
 * for the members' notices no account of the member that did it (a
 * council's account is shared). What an Admin did while acting as an
 * account is not that account's act, so it reaches it, as in the news.
 */

/** One email to queue (an email_deliveries row). */
export interface PlannedDelivery {
  kind: NotificationKind;
  userId: string;
  dedupeKey: string;
  frequency: NotificationFrequency;
}

async function loadFacts(
  event: NotifyingEvent,
  executor: Executor,
): Promise<PlanFacts> {
  if (event.entityType === "document") {
    const [row] = await executor
      .select({ proponentMemberId: documents.proponentMemberId })
      .from(documents)
      .where(eq(documents.id, event.entityId));
    const co = (await loadCoProponentIds([event.entityId], executor)).get(
      event.entityId,
    );
    return {
      documentPresenterIds: [
        ...(row?.proponentMemberId ? [row.proponentMemberId] : []),
        ...(co ?? []),
      ],
      amendment: null,
    };
  }
  if (event.entityType === "amendment") {
    const [row] = await findAmendmentsByIds([event.entityId]);
    return {
      documentPresenterIds: [],
      amendment: row
        ? {
            transactional: row.kind === "transactional",
            status: row.status,
            validated: row.validatedAt !== null,
            authorIds: row.authors.map((author) => author.memberId),
            parties: row.acceptances
              .filter((acceptance) => acceptance.role === "author")
              .map((acceptance) => ({
                memberId: acceptance.memberId,
                decision: acceptance.decision,
              })),
          }
        : null,
    };
  }
  return { documentPresenterIds: [], amendment: null };
}

/**
 * The emails one event queues under the settings in force: one per account
 * and notice, for accounts with access only, nobody about their own act.
 */
export async function planDeliveries(
  event: NotifyingEvent,
  settings: NotificationSettings,
  executor: Executor = db,
): Promise<PlannedDelivery[]> {
  if (!settings.enabled) return [];
  const notices = noticesForEvent(
    event,
    await loadFacts(event, executor),
  ).filter((notice) => settings.kinds[notice.kind].enabled);
  if (notices.length === 0) return [];

  const ownAct = event.impersonationId === null;
  const planned: PlannedDelivery[] = [];
  for (const notice of notices) {
    const config = settings.kinds[notice.kind];
    const audience = NOTIFICATION_AUDIENCE[notice.kind];
    let accounts: { id: string; memberId: string | null }[];
    if (audience === "roles") {
      if (config.roles.length === 0) continue;
      accounts = await executor
        .select({ id: users.id, memberId: users.memberId })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(
          and(inArray(roles.name, config.roles), isNull(users.accessRevokedAt)),
        );
    } else {
      accounts = await executor
        .select({ id: users.id, memberId: users.memberId })
        .from(users)
        .where(
          and(
            inArray(users.memberId, notice.memberIds),
            isNull(users.accessRevokedAt),
          ),
        );
    }
    for (const account of accounts) {
      if (ownAct && account.id === event.actorUserId) continue;
      if (
        ownAct &&
        audience === "presenters" &&
        event.actorMemberId !== null &&
        account.memberId === event.actorMemberId
      ) {
        continue;
      }
      planned.push({
        kind: notice.kind,
        userId: account.id,
        dedupeKey: notice.dedupeKey,
        frequency: config.frequency,
      });
    }
  }
  return planned;
}

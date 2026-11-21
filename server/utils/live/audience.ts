import { eq, inArray, or } from "drizzle-orm";
import {
  amendmentAcceptances,
  amendmentAuthors,
  amendmentSources,
  amendments,
  documentProponents,
  documents,
} from "../../db/schema";
import type { Executor } from "../domain/events";

/**
 * Who a live message is for, when not everyone can see what it is about
 * (VAL-1 of the performance report of 2026-11): the accounts and members
 * who see the amendment as its insiders, besides those who see every
 * unpublished amendment (liveMessageReaches, ./audienceFilter.ts). Absent
 * means everyone, as for every other message. It travels in the NOTIFY
 * payload only, never in LiveEventDto: it trims who is told, while what
 * anyone reads stays decided by the permission-checked endpoints, so a
 * message delivered too widely only costs a refetch, and one withheld from
 * someone who sees the amendment would leave a stale screen. Hence every
 * rule here fails open: when in doubt, no audience.
 */
export interface LiveAudience {
  /** Accounts that see it: the one that created it. */
  userIds: string[];
  /**
   * Members whose accounts see it: its authors and, for a transactional, its
   * parties and the authors of the amendments it groups.
   */
  memberIds: string[];
}

/**
 * Amendment events that may concern an amendment the room cannot see yet
 * (a draft, a presented one not published), each recorded after the insert
 * or update it reports, so recordEvent reads the amendment as it now is:
 * - `amendment_created`, `amendment_updated`, `amendment_deleted`: drafts
 *   (a transactional the Mesa presents in session is created published);
 * - `amendment_submitted`: presented, not published until validated;
 * - `amendment_validated`: kept private unless `publish`;
 * - `acceptance_recorded`: a party's answer, recorded before what it leads
 *   to (closing the transactional is an event of its own);
 * - `amendment_correction_requested`: back to its authors, and public
 *   before only when `published` says so.
 * Every other event reaches everyone.
 */
export const AUDIENCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "amendment_created",
  "amendment_updated",
  "amendment_deleted",
  "amendment_submitted",
  "amendment_validated",
  "acceptance_recorded",
  "amendment_correction_requested",
]);

/** The amendment as recordEvent's transaction sees it, for its audience. */
export interface AmendmentAudienceRow {
  publishedAt: Date | null;
  createdByUserId: string | null;
  memberIds: readonly string[];
}

/** An audience longer than this is not worth the NOTIFY payload: everyone. */
const MAX_AUDIENCE_IDS = 200;

function strings(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function audienceOf(
  userIds: readonly string[],
  memberIds: readonly string[],
): LiveAudience | null {
  const audience = {
    userIds: [...new Set(userIds)],
    memberIds: [...new Set(memberIds)],
  };
  if (audience.userIds.length + audience.memberIds.length > MAX_AUDIENCE_IDS)
    return null;
  return audience;
}

/**
 * What an event's payload alone says of its audience: everyone (null), an
 * audience, or `"row"` when the amendment as it stands decides. Public by
 * the payload: validated and published at once (`publish`), a correction
 * asked of an amendment that was published (`published`), the Mesa's
 * transactional presented in session (admitted on presentation). A draft
 * whose authors change (`amendment_updated` naming them) goes to everyone,
 * since an author it no longer lists must still hear that it lost it.
 * `amendment_deleted` names its creator and authors, the row being gone; a
 * deleted transactional goes to everyone (its parties are not named).
 */
function audienceByPayload(
  type: string,
  payload: Record<string, unknown>,
): LiveAudience | null | "row" {
  if (!AUDIENCE_EVENT_TYPES.has(type)) return null;
  if (payload.publish === true || payload.published === true) return null;
  if (type === "amendment_submitted" && payload.admission === "admitted")
    return null;
  if (
    type === "amendment_updated" &&
    ("authorMemberIds" in payload ||
      "mainAuthorId" in payload ||
      "onBehalfOfMemberId" in payload)
  ) {
    return null;
  }
  if (type === "amendment_deleted") {
    if (typeof payload.kind !== "string" || payload.kind === "transactional")
      return null;
    return audienceOf(strings(payload.createdByUserId), [
      ...strings(payload.authorMemberIds),
      ...strings(payload.mainAuthorId),
    ]);
  }
  return "row";
}

/**
 * The audience of an amendment event (AUDIENCE_EVENT_TYPES), or null for
 * everyone: what its payload says (audienceByPayload), otherwise the
 * amendment as recordEvent's transaction sees it (`row`): published, or not
 * found, means everyone; otherwise its creator and members.
 */
export function amendmentAudience(
  type: string,
  payload: Record<string, unknown>,
  row: AmendmentAudienceRow | null,
): LiveAudience | null {
  const byPayload = audienceByPayload(type, payload);
  if (byPayload !== "row") return byPayload;
  if (!row || row.publishedAt) return null;
  return audienceOf(strings(row.createdByUserId), row.memberIds);
}

/**
 * Reads what amendmentAudience needs, inside recordEvent's transaction:
 * the amendment, its authors and, for a transactional, its parties and the
 * authors of what it groups. Plain reads by key.
 */
export async function loadAmendmentAudienceRow(
  executor: Executor,
  amendmentId: string,
): Promise<AmendmentAudienceRow | null> {
  const [row] = await executor
    .select({
      kind: amendments.kind,
      documentId: amendments.documentId,
      publishedAt: amendments.publishedAt,
      createdByUserId: amendments.createdByUserId,
    })
    .from(amendments)
    .where(eq(amendments.id, amendmentId));
  if (!row) return null;
  if (row.publishedAt) {
    return {
      publishedAt: row.publishedAt,
      createdByUserId: row.createdByUserId,
      memberIds: [],
    };
  }
  const transactional = row.kind === "transactional";
  const authors = await executor
    .select({ memberId: amendmentAuthors.memberId })
    .from(amendmentAuthors)
    .where(
      transactional
        ? or(
            eq(amendmentAuthors.amendmentId, amendmentId),
            inArray(
              amendmentAuthors.amendmentId,
              executor
                .select({ id: amendmentSources.sourceId })
                .from(amendmentSources)
                .where(eq(amendmentSources.transactionalId, amendmentId)),
            ),
          )
        : eq(amendmentAuthors.amendmentId, amendmentId),
    );
  const parties = transactional
    ? await executor
        .select({ memberId: amendmentAcceptances.memberId })
        .from(amendmentAcceptances)
        .where(eq(amendmentAcceptances.amendmentId, amendmentId))
    : [];
  // A transactional also reaches the presenters of its document once
  // presented (presentsTransactionalDocument in visibility.ts).
  const presenters = transactional
    ? await executor
        .select({ memberId: documents.proponentMemberId })
        .from(documents)
        .where(eq(documents.id, row.documentId))
        .union(
          executor
            .select({ memberId: documentProponents.memberId })
            .from(documentProponents)
            .where(eq(documentProponents.documentId, row.documentId)),
        )
    : [];
  return {
    publishedAt: null,
    createdByUserId: row.createdByUserId,
    memberIds: [
      ...[...authors, ...parties].map((item) => item.memberId),
      ...presenters
        .map((item) => item.memberId)
        .filter((id): id is string => id !== null),
    ],
  };
}

/**
 * The audience of an event about to be recorded (amendmentAudience), or
 * null for everyone. Only amendment events of AUDIENCE_EVENT_TYPES whose
 * payload does not settle it read the amendment; should the read throw,
 * everyone. The reads run in a savepoint (a nested transaction): in the
 * caller's transaction a failed statement would abort it, and the change
 * the event reports would roll back with the notice; the savepoint rolls
 * back alone.
 */
export async function liveAudienceOf(
  executor: Executor,
  input: {
    entityType: string;
    entityId: string;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<LiveAudience | null> {
  if (input.entityType !== "amendment") return null;
  const payload = input.payload ?? {};
  const byPayload = audienceByPayload(input.type, payload);
  if (byPayload !== "row") return byPayload;
  try {
    const row = await executor.transaction((savepoint) =>
      loadAmendmentAudienceRow(savepoint, input.entityId),
    );
    return amendmentAudience(input.type, payload, row);
  } catch {
    return null;
  }
}

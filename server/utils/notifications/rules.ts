import {
  NOTIFICATION_AUDIENCE,
  type NotificationKind,
} from "~~/shared/constants/notifications";

/**
 * Which notices one committed event gives rise to (docs/design.md, "Email
 * notifications"), before settings and accounts: pure, so the rule is
 * tested on its own. planDeliveries (./plan.ts) loads the facts and turns
 * the notices into one email per account.
 */

/** The columns of an event the plan reads. */
export interface NotifyingEvent {
  id: string;
  assemblyId: string;
  entityType: string;
  entityId: string;
  type: string;
  payload: Record<string, unknown>;
  actorUserId: string | null;
  actorMemberId: string | null;
  impersonationId: string | null;
}

/** What the plan knows about the entity, as it is once committed. */
export interface PlanFacts {
  /** A document event: its main presenter and co-presenters. */
  documentPresenterIds: string[];
  /** An amendment event: the amendment (null when gone). */
  amendment: {
    transactional: boolean;
    status: string;
    validated: boolean;
    authorIds: string[];
    /** A transactional's parties (role "author") and their answers. */
    parties: { memberId: string; decision: string }[];
  } | null;
}

export interface PlannedNotice {
  kind: NotificationKind;
  /** For the members' notices: the members whose accounts get it. */
  memberIds: string[];
  /** Unique per account (email_deliveries.dedupe_key). */
  dedupeKey: string;
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function change(
  payload: Record<string, unknown>,
  key: string,
): { from: unknown; to: unknown } | null {
  const changes = payload.changes;
  if (!changes || typeof changes !== "object") return null;
  const entry = (changes as Record<string, unknown>)[key];
  if (!entry || typeof entry !== "object") return null;
  const { from, to } = entry as { from?: unknown; to?: unknown };
  return { from, to };
}

/** The notices one event gives rise to, before settings and accounts. */
export function noticesForEvent(
  event: NotifyingEvent,
  facts: PlanFacts,
): PlannedNotice[] {
  const notices: PlannedNotice[] = [];
  const add = (
    kind: NotificationKind,
    memberIds: string[] = [],
    dedupeKey = `${kind}:${event.id}`,
  ) => {
    if (NOTIFICATION_AUDIENCE[kind] === "presenters" && memberIds.length === 0)
      return;
    notices.push({ kind, memberIds: [...new Set(memberIds)], dedupeKey });
  };
  const presenters = facts.documentPresenterIds;
  const amendment = facts.amendment;
  const authors = amendment?.authorIds ?? [];
  // A transactional reaching the Secretaría is told once, whichever path
  // gets it there (and however many times an answer is recorded again).
  const readyKey = `transactional_ready:${event.entityId}`;

  switch (event.type) {
    case "document_created":
      add("presenter_assigned", presenters);
      break;
    case "document_updated": {
      const main = change(event.payload, "proponentMemberId");
      const co = change(event.payload, "coProponentMemberIds");
      const assigned = [
        ...(main && typeof main.to === "string" ? [main.to] : []),
        ...(co ? ids(co.to).filter((id) => !ids(co.from).includes(id)) : []),
      ];
      add("presenter_assigned", assigned);
      if (change(event.payload, "dueAt")) {
        add(
          "presenter_changed",
          presenters.filter((id) => !assigned.includes(id)),
        );
      }
      break;
    }
    case "document_submitted":
      add("document_submitted");
      break;
    case "document_correction_requested":
      add("presenter_correction", presenters);
      break;
    case "document_published":
      add("submission_validated");
      add("presenter_validated", presenters);
      break;
    case "document_voted":
      add("presenter_decided", presenters);
      break;
    case "amendment_submitted":
      if (!amendment) break;
      if (!amendment.transactional) {
        add("amendment_submitted");
      } else if (event.payload.awaitsAuthors === true) {
        add(
          "transactional_acceptance_requested",
          amendment.parties
            .filter((party) => party.decision === "pending")
            .map((party) => party.memberId),
        );
      } else if (event.payload.admission !== "admitted") {
        // Every party accepted already (the proposer was the only one):
        // straight to the Secretaría. One the Mesa presents is admitted at
        // once and needs no validation.
        add("transactional_ready", [], readyKey);
      }
      break;
    case "acceptance_recorded":
      if (
        amendment?.transactional &&
        amendment.status === "submitted" &&
        !amendment.validated &&
        amendment.parties.length > 0 &&
        amendment.parties.every((party) => party.decision === "accepted")
      ) {
        add("transactional_ready", [], readyKey);
      }
      break;
    case "amendment_validated":
      // The Mesa's own transactional, validated as it presents it.
      if (event.payload.method === "mesa") break;
      add("submission_validated");
      add("presenter_validated", authors);
      break;
    case "amendment_correction_requested":
      add("presenter_correction", authors);
      break;
    case "amendment_admitted":
      add("presenter_validated", authors);
      break;
    case "amendment_inadmissible":
    case "amendment_approved":
    case "amendment_rejected":
    case "amendment_lapsed":
    case "amendment_transacted":
    case "amendment_withdrawn":
      add("presenter_decided", authors);
      break;
    case "amendment_reclassified":
    case "amendment_authors_changed":
      add("presenter_changed", authors);
      break;
  }
  return notices;
}

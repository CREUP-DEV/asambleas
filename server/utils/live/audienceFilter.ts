import {
  actsFor,
  canManageAssemblies,
  canManageDocuments,
  type Actor,
} from "../domain/actor";
import type { LiveMessage } from "../domain/events";
import {
  seesAllPresentedAmendments,
  seesPresentedAmendments,
  seesValidatedAmendments,
  seesWithdrawnAmendments,
} from "../domain/visibility";

/**
 * Whether the live stream of `actor` is told of `message`: always, unless
 * the message names an audience (LiveAudience, ./audience.ts), which only
 * amendment events the room may not see do. Then it reaches those who see
 * unpublished amendments whatever they are (the Secretaría, the Mesa, the
 * CEA's accounts and the control sheet's readers: canSeeAmendment's rules
 * for drafts, presented, validated and withdrawn ones, taken together so
 * the answer holds before and after the change), those who manage
 * documents or assemblies (they read whether a document has any amendment,
 * drafts included: DocumentSummaryDto.hasAmendments, seesAmendmentExistence),
 * the account that created the amendment and the accounts that act for one
 * of its members. A malformed audience reaches everyone.
 *
 * The actor is the one the stream was opened with: a role or member that
 * changes applies once the stream reconnects.
 */
export function liveMessageReaches(
  actor: Actor,
  message: Pick<LiveMessage, "audience">,
): boolean {
  const audience = message.audience;
  if (
    !audience ||
    !Array.isArray(audience.userIds) ||
    !Array.isArray(audience.memberIds)
  )
    return true;
  if (
    seesAllPresentedAmendments(actor) ||
    seesPresentedAmendments(actor) ||
    seesValidatedAmendments(actor) ||
    seesWithdrawnAmendments(actor) ||
    canManageDocuments(actor) ||
    canManageAssemblies(actor)
  )
    return true;
  if (audience.userIds.includes(actor.user.id)) return true;
  return actsFor(actor, audience.memberIds);
}

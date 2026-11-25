import type { DocumentStatus } from "~~/shared/constants/domain";
import type { Milestones } from "~~/shared/utils/calendar";
import { documentAmendable, documentVoted } from "./amendments";
import { presentationClosed, type PresentationItem } from "./documents";

/**
 * What the home page (GET /api/me/work) and the Secretaría's inbox leave
 * out because the server would refuse it: the same predicates the writes
 * check, read here as filters. docs/api.md, "Review and work".
 */

/**
 * Documents off the table in their assembly: withdrawn or postponed. Their
 * amendments wait for nobody (neither the inbox nor its counts list them)
 * until the document is published again.
 */
export const SHELVED_DOCUMENT_STATUSES = [
  "withdrawn",
  "postponed",
] as const satisfies readonly DocumentStatus[];

export function isShelvedDocument(document: {
  status: DocumentStatus;
}): boolean {
  return (SHELVED_DOCUMENT_STATUSES as readonly DocumentStatus[]).includes(
    document.status,
  );
}

/**
 * Whether one of the member's documents is still something to do on the
 * home page. A draft is not once its presentation is closed for the actor
 * (presentationClosed, which submitDocument checks): past its kind's own
 * deadline (presentationDeadlinePassed), not expected by the Secretaría and
 * not sent back for a correction.
 * Managers are not bound by the deadline, and a document whose agenda item
 * is gone is not checked (as in submitDocument). Other statuses always stay:
 * they are where the document stands, not a task.
 */
export function isWorkDocumentOpen(
  document: Parameters<typeof presentationClosed>[0] & {
    status: DocumentStatus;
  },
  item: PresentationItem | undefined,
  milestones: Milestones,
  manager: boolean,
  now = new Date(),
): boolean {
  if (document.status !== "draft" || manager || !item) return true;
  return !presentationClosed(document, item, milestones, now);
}

/**
 * Whether the authors can still edit or present a draft amendment to this
 * document: what assertAmendable in amendments.ts checks (documentAmendable,
 * then documentVoted); the assembly being open is left to the caller.
 */
export function acceptsAmendmentDrafts(document: {
  status: DocumentStatus;
  format: string;
  amendable: boolean;
  baseVersionId: string | null;
  finalVoteId: string | null;
  consolidatedVersionId: string | null;
}): boolean {
  return documentAmendable(document) && !documentVoted(document);
}

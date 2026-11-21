/**
 * Answering «Propone una transaccional» and going to write it (user's
 * decision of 2026-11-21): the one rule the control sheet's answer, the
 * workspace's answer and the presenter's review share for offering it and
 * for opening the transactional composer afterwards. Pure, unit-tested
 * (transactAnswer.test.ts); the dialog is useTransactAnswer.
 */

import type { RouteLocationRaw } from "vue-router";
import type { AmendmentDto, DocumentSummaryDto } from "~~/shared/types/api";
import {
  answerableAfterDecision,
  rejectedByAnswer,
} from "~~/shared/utils/positions";
import {
  isSessionIncorporated,
  sessionPendingTransactionalIds,
} from "~/composables/session/sessionModel";
import {
  transactionalSourceEligible,
  transactionalStandIn,
} from "./transactional";

/** What the dialog answers: nothing, the answer alone, or the answer and… */
export type TransactAnswerResult =
  | { action: "cancel" }
  | { action: "save" }
  /** …writing a new transactional over it. */
  | { action: "draft" }
  /** …opening the transactional over it already on its way. */
  | { action: "open"; id: string };

type Combinable = Pick<
  AmendmentDto,
  | "kind"
  | "status"
  | "admission"
  | "decidedAt"
  | "reviewState"
  | "ops"
  | "acceptances"
  | "approvalMethod"
  | "outcomeVote"
>;

/**
 * Whether a transactional could combine the amendment once it is answered
 * «transacciona»: as it stands (transactionalSourceEligible), or as that
 * answer leaves it when it reopens it (one the presenter's acceptance
 * incorporated, or a formal one its rejection closed). Never one the
 * assembly already decided otherwise (answerableAfterDecision): its answer
 * changes nothing there.
 */
export function combinableOnTransact(amendment: Combinable): boolean {
  if (
    isSessionIncorporated(amendment as AmendmentDto) ||
    rejectedByAnswer(amendment, amendment.outcomeVote !== null)
  ) {
    return transactionalSourceEligible({
      ...amendment,
      status: "submitted",
      decidedAt: null,
    });
  }
  if (answerableAfterDecision(amendment)) return false;
  return transactionalSourceEligible(amendment);
}

/** What offering it needs besides the amendment. */
export interface TransactOfferContext {
  document: Pick<DocumentSummaryDto, "format" | "status"> & {
    /** Its final vote is recorded (a DocumentDto's `finalVote`, or `voted`). */
    finalVoted: boolean;
  };
  assemblyClosed: boolean;
  /**
   * The viewer may write a transactional over it from the workspace: the
   * Mesa, a presenter of the document, or whoever the page's canTransact
   * and transactAny let combine it.
   */
  canDraft: boolean;
}

/**
 * «Propone una transaccional» leads somewhere for this viewer: the
 * workspace's composer would open on it (structured, published, not voted,
 * the assembly open, a viewer who may write one, an amendment it can
 * combine). Otherwise the answer is not offered where it is a step to the
 * composer (the control sheet) and asks nothing where it is offered anyway.
 */
export function transactAnswerLeads(
  amendment: Combinable,
  context: TransactOfferContext,
): boolean {
  const { document } = context;
  return (
    context.canDraft &&
    !context.assemblyClosed &&
    document.format === "structured" &&
    document.status === "published" &&
    !document.finalVoted &&
    combinableOnTransact(amendment)
  );
}

/**
 * After the answer is saved, the amendment as the server returned it can
 * still be combined (the composer keeps only those, or the transactional
 * that stands in for it): otherwise the composer would open empty.
 */
export function composerTakes(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): boolean {
  return (
    transactionalSourceEligible(amendment) ||
    transactionalStandIn(amendment, byId) !== null
  );
}

/** The transactionals over it still on their way, as the viewer sees them. */
export function pendingTransactionalsOver(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): AmendmentDto[] {
  return sessionPendingTransactionalIds(amendment, byId)
    .map((id) => byId.get(id))
    .filter((entry): entry is AmendmentDto => entry !== undefined);
}

/** The workspace's composer on these amendments (`?transaccional=`). */
export function transactComposerLocation(
  documentPath: string,
  ids: readonly string[],
): RouteLocationRaw {
  return { path: documentPath, query: { transaccional: ids.join(",") } };
}

/** An amendment open in the workspace (`?enmienda=`). */
export function workspaceAmendmentLocation(
  documentPath: string,
  id: string,
): RouteLocationRaw {
  return { path: documentPath, query: { enmienda: id } };
}

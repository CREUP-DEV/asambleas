import type {
  AcceptedAmendmentRule,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
} from "../constants/domain";

/**
 * The rule an amendment's acceptance follows: a formal amendment ("de
 * forma") is always incorporated by its main presenter's acceptance (the
 * automatic one included), whatever the document's rule (user's decision of
 * 2026-11-20); rejecting it rejects it (rejectedByAnswer), and the Mesa may
 * reopen it. Any other kind follows the document
 * (documents.acceptedAmendments). Read
 * on the server (positionEffect, positionBlocker, acceptedRulePlan) and on
 * the client, so both say the same.
 */
export function amendmentRule(
  kind: AmendmentKind | undefined,
  documentRule: AcceptedAmendmentRule,
): AcceptedAmendmentRule {
  return kind === "formal" ? "incorporate" : documentRule;
}

/**
 * Whether the Secretaría's validation always publishes an amendment of this
 * kind, whatever it chose: a transactional replaces amendments everyone
 * already reads, and a formal one goes into the text at once (amendmentRule,
 * user's decision of 2026-11-20). The server's publishOnValidation and the
 * review forms (no «Validar sin publicar» for them) read it.
 */
export function alwaysPublishedOnValidation(
  kind: AmendmentKind | undefined,
): boolean {
  return kind === "transactional" || kind === "formal";
}

/**
 * Whether the main presenter's answers to a document's amendments are
 * public: once the Secretaría publishes them, or for good once the debate
 * of the document's agenda item starts (documents.positions_published_at,
 * documents.positions_debate_started_at). The presenters, the Mesa and
 * whoever reviews amendments read them before (canSeePositions).
 */
export interface PositionsPublication {
  positionsPublishedAt: Date | string | null;
  positionsDebateStartedAt: Date | string | null;
}

export function positionsArePublic(document: PositionsPublication): boolean {
  return (
    document.positionsPublishedAt !== null ||
    document.positionsDebateStartedAt !== null
  );
}

/**
 * Since when the answers are public (positionsArePublic): the earlier of
 * the publication and the start of the debate, among those set. Null while
 * they are not public. A publication taken back and made again counts from
 * the new one, since the answers were hidden in between.
 */
export function positionsPublicSince(
  document: PositionsPublication,
): Date | null {
  let since: number | null = null;
  for (const value of [
    document.positionsPublishedAt,
    document.positionsDebateStartedAt,
  ]) {
    if (value === null) continue;
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms) && (since === null || ms < since)) since = ms;
  }
  return since === null ? null : new Date(since);
}

/**
 * Whether the Secretaría may take the publication back: only what it
 * published itself, and only until the debate starts.
 */
export function positionsUnpublishable(
  document: PositionsPublication,
): boolean {
  return (
    document.positionsPublishedAt !== null &&
    document.positionsDebateStartedAt === null
  );
}

/**
 * An amendment the assembly already decided whose main presenter may still
 * change its answer until the document's final vote: one approved by a
 * vote, by assent or as a formal one (user's decision of 2026-11-19), and
 * one rejected (2026-11-21). The answer is recorded and nothing else
 * changes (positionEffect returns null), so the outcome and the text stay as
 * they are: accepting a rejected one does not approve it. One the
 * presenter's acceptance incorporated (approval method "proponent") follows
 * its own rule, as does a formal one the presenter's rejection closed
 * (rejectedByAnswer). The server's positionBlocker and the client's mirror
 * (amendmentAnswerable in ~/composables/amendment/workspace) both read it,
 * so they never drift.
 */
export function answerableAfterDecision(row: {
  status: AmendmentStatus;
  approvalMethod: ApprovalMethod | null;
}): boolean {
  if (row.status === "rejected") return true;
  return (
    row.status === "approved" &&
    row.approvalMethod !== null &&
    row.approvalMethod !== "proponent"
  );
}

/**
 * A formal amendment its main presenter's rejection closed (user's decision
 * of 2026-11-20): formal ones the presenter rejects are not debated by
 * default, so the answer rejects it at once (positionEffect "reject"), also
 * once its acceptance had incorporated it. It is told by its having no
 * vote: the Mesa rejects only by vote. Its answer stays open until the
 * final vote: any other answer reopens it ("reopen_rejected", and an
 * acceptance incorporates it again), and the Mesa may reopen it to debate
 * and vote it.
 */
export function rejectedByAnswer(
  row: { kind: AmendmentKind; status: AmendmentStatus },
  hasVote: boolean,
): boolean {
  return row.kind === "formal" && row.status === "rejected" && !hasVote;
}

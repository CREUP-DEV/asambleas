import type { AmendmentStatus, ApprovalMethod } from "../constants/domain";

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
 * An amendment the assembly already approved (by a vote, by assent, or as a
 * formal one) whose main presenter may still change its answer until the
 * document's final vote (user's decision of 2026-11-19): the answer is
 * recorded and nothing else changes (positionEffect returns null), so the
 * approval and the text stay as they are. One the presenter's acceptance
 * incorporated (approval method "proponent") follows its own rule, and a
 * rejected one stays closed. The server's positionBlocker and the client's
 * mirror (amendmentAnswerable in ~/composables/amendment/workspace) both
 * read it, so they never drift.
 */
export function answerableAfterDecision(row: {
  status: AmendmentStatus;
  approvalMethod: ApprovalMethod | null;
}): boolean {
  return (
    row.status === "approved" &&
    row.approvalMethod !== null &&
    row.approvalMethod !== "proponent"
  );
}

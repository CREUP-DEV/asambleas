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

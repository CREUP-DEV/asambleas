import type {
  AcceptanceDecision,
  AcceptanceRole,
  AmendmentKind,
  AmendmentStatus,
  ProponentPosition,
} from "../constants/domain";

/**
 * The order a document's amendments are shown and debated in (user's
 * decisions of 2026-11-19 and 2026-11-20). Text order (where they act in
 * the base text, then presentation order), grouped first, each group in
 * text order:
 * 0. accepted by the main presenter and not transacted: the ones proposed
 *    for approval as a bloc;
 * 1. the transactions the main presenter accepted: transactionals it
 *    accepted (as a party, or by its answer), the amendments answered
 *    "transact", and the ones a transactional already replaced;
 * 2. rejected by the main presenter (transactionals it rejected too);
 * 3. the rest (no answer, or pending);
 * 4. formal amendments the main presenter rejected: by default they are
 *    not debated.
 * On screen it is grouped whether the answers are public or not yet, by the
 * answer as the reader gets it (null, the rest, when it may not read it):
 * the order never tells an answer a reader does not read. A public export
 * groups only once they are public (buildAnnexRows).
 */
export interface AmendmentOrderOptions {
  /** Group by the main presenter's answer (see above). */
  byAnswer?: boolean;
}

export type AmendmentAnswerRank = 0 | 1 | 2 | 3 | 4;

/** What the order reads of an amendment. */
export interface AmendmentOrderSubject {
  kind: AmendmentKind;
  /** The main presenter's answer, as the reader gets it (null if none). */
  position?: { position: ProponentPosition } | null;
  /** Its status: one a transactional replaced goes with the transactions. */
  status?: AmendmentStatus;
  /** A transactional's parties: the main presenter's acceptance counts. */
  acceptances?: readonly {
    role: AcceptanceRole;
    decision: AcceptanceDecision;
  }[];
}

/** The main presenter accepted this transactional, as a party or by answer. */
function proponentAccepted(amendment: AmendmentOrderSubject): boolean {
  return (
    amendment.position?.position === "accept" ||
    (amendment.acceptances ?? []).some(
      (party) => party.role === "proponent" && party.decision === "accepted",
    )
  );
}

/** The group an amendment goes in (see AmendmentOrderOptions). */
export function amendmentAnswerRank(
  amendment: AmendmentOrderSubject,
): AmendmentAnswerRank {
  const answer = amendment.position?.position;
  if (amendment.kind === "transactional") {
    if (proponentAccepted(amendment)) return 1;
    return answer === "reject" ? 2 : 3;
  }
  if (amendment.status === "transacted") return 1;
  switch (answer) {
    case "accept":
      return 0;
    case "transact":
      return 1;
    case "reject":
      return amendment.kind === "formal" ? 4 : 2;
    default:
      return 3;
  }
}

/**
 * The rank to sort by before text order: the group's when grouping by
 * answer, the same for every amendment otherwise (text order alone).
 */
export function amendmentOrderRank(
  amendment: AmendmentOrderSubject,
  options: AmendmentOrderOptions = {},
): AmendmentAnswerRank {
  return options.byAnswer ? amendmentAnswerRank(amendment) : 0;
}

/**
 * Compares two amendments by their group (only when grouping by answer);
 * 0 when they share it, so text order decides.
 */
export function compareAmendmentAnswers(
  a: AmendmentOrderSubject,
  b: AmendmentOrderSubject,
  options: AmendmentOrderOptions = {},
): number {
  return amendmentOrderRank(a, options) - amendmentOrderRank(b, options);
}

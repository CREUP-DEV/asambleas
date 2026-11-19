import type { AmendmentKind, ProponentPosition } from "../constants/domain";

/**
 * The order a document's amendments are shown and debated in (user's
 * decisions of 2026-11-19). Text order (where they act in the base text,
 * then presentation order), grouped first, each group in text order:
 * 0. transactionals, and those accepted or answered with "transact";
 * 1. rejected;
 * 2. the rest (no answer, or pending).
 * On screen it is grouped whether the answers are public or not yet, by the
 * answer as the reader gets it (null, the rest, when it may not read it):
 * the order never tells an answer a reader does not read. A public export
 * groups only once they are public (buildAnnexRows).
 */
export interface AmendmentOrderOptions {
  /** Group by the main presenter's answer (see above). */
  byAnswer?: boolean;
}

export type AmendmentAnswerRank = 0 | 1 | 2;

/** What the order reads of an amendment. */
export interface AmendmentOrderSubject {
  kind: AmendmentKind;
  /** The main presenter's answer, as the reader gets it (null if none). */
  position?: { position: ProponentPosition } | null;
}

/** The group an amendment goes in (see AmendmentOrderOptions). */
export function amendmentAnswerRank(
  amendment: AmendmentOrderSubject,
): AmendmentAnswerRank {
  // A transactional is the agreement itself: it goes with the accepted.
  if (amendment.kind === "transactional") return 0;
  switch (amendment.position?.position) {
    case "accept":
    case "transact":
      return 0;
    case "reject":
      return 1;
    default:
      return 2;
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

import type { AmendmentKind, ProponentPosition } from "../constants/domain";

/**
 * The order a document's amendments are shown and debated in (user's
 * decision of 2026-11-19). Always text order (where they act in the base
 * text, then presentation order); once the main presenter's answers are
 * public (positionsArePublic), grouped first, each group in text order:
 * 0. transactionals, and those accepted or answered with "transact";
 * 1. rejected;
 * 2. the rest (no answer, or pending).
 * Before publication the order stays the text's for every viewer, the Mesa
 * included, even though it reads the answers earlier.
 */
export interface AmendmentOrderOptions {
  /** The document's answers are public (positionsArePublic). */
  answersPublic?: boolean;
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
 * The rank to sort by before text order: the group's while the answers are
 * public, the same for every amendment otherwise (text order alone).
 */
export function amendmentOrderRank(
  amendment: AmendmentOrderSubject,
  options: AmendmentOrderOptions = {},
): AmendmentAnswerRank {
  return options.answersPublic ? amendmentAnswerRank(amendment) : 0;
}

/**
 * Compares two amendments by their group (only while the answers are
 * public); 0 when they share it, so text order decides.
 */
export function compareAmendmentAnswers(
  a: AmendmentOrderSubject,
  b: AmendmentOrderSubject,
  options: AmendmentOrderOptions = {},
): number {
  return amendmentOrderRank(a, options) - amendmentOrderRank(b, options);
}

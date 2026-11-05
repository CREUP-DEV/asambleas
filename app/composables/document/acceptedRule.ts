import type { AcceptedAmendmentRule } from "~~/shared/constants/domain";
import type { DocumentDto } from "~~/shared/types/api";

/**
 * What a document's rule for accepted amendments (`acceptedAmendments`)
 * means once the document is published. Changing it then also changes the
 * amendments its main presenter already answered (docs/api.md "Accepted
 * amendments"):
 * - to "incorporate", the ones it already accepted are approved and go into
 *   the text without a vote;
 * - to "vote", the ones its acceptance approved go back to undecided, for
 *   the assembly to vote.
 * After the final vote, or once the consolidated text exists, the rule no
 * longer changes (the server answers 409). Pure: components translate.
 */

/** The fields of a document that say whether its rule can still change. */
export type AcceptedRuleDocument = Pick<DocumentDto, "publishedAt"> &
  Partial<
    Pick<DocumentDto, "finalVote" | "consolidatedVersion" | "consolidated">
  >;

/**
 * The rule can no longer change: the document is published and its text is
 * settled (final vote held or consolidated text produced).
 */
export function acceptedRuleLocked(document: AcceptedRuleDocument): boolean {
  if (document.publishedAt === null) return false;
  return (
    (document.finalVote ?? null) !== null ||
    (document.consolidatedVersion ?? null) !== null ||
    document.consolidated === true
  );
}

/**
 * The rule a save would switch a published document to, so the form can
 * warn first: "incorporate" approves what the main presenter already
 * accepted, "vote" sends what its acceptance approved back to the vote.
 * Null when saving changes nothing already answered: not published, locked,
 * no stored rule to compare with, or the same rule.
 */
export function acceptedRuleChange(input: {
  published: boolean;
  locked: boolean;
  stored: AcceptedAmendmentRule | null | undefined;
  next: AcceptedAmendmentRule;
}): AcceptedAmendmentRule | null {
  if (!input.published || input.locked || !input.stored) return null;
  return input.next === input.stored ? null : input.next;
}

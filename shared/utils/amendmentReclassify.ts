import type {
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
} from "../constants/domain";

/**
 * Reclassifying an amendment: the Secretaría moves it between "de forma"
 * (`formal`) and the usual content kind (`partial`). Both kinds carry the
 * same operations, so nothing else is stored to go back. Transactionals
 * are what they are and cannot be reclassified.
 */
export type ReclassifiableKind = Extract<AmendmentKind, "formal" | "partial">;

export const RECLASSIFIABLE_KINDS = [
  "partial",
  "formal",
] as const satisfies readonly ReclassifiableKind[];

/** The kind an amendment of this kind can be moved to, or null. */
export function reclassifyTarget(
  kind: AmendmentKind,
): ReclassifiableKind | null {
  if (kind === "formal") return "partial";
  if (kind === "partial") return "formal";
  return null;
}

/**
 * Whether an amendment can be reclassified now: presented and undecided, of
 * a kind that has a counterpart, in a document not voted yet. One the main
 * presenter's acceptance incorporated (approved with the method
 * "proponent") still counts as undecided, since changing that answer takes
 * it out again: a formal one accepted by itself goes back to unanswered
 * when it becomes a content amendment. Who may do it (amendment:review) is
 * checked apart.
 */
export function canReclassifyAmendment(
  amendment: {
    kind: AmendmentKind;
    status: AmendmentStatus;
    approvalMethod?: ApprovalMethod | null;
  },
  documentVoted: boolean,
): boolean {
  return (
    !documentVoted &&
    (amendment.status === "submitted" ||
      (amendment.status === "approved" &&
        amendment.approvalMethod === "proponent")) &&
    reclassifyTarget(amendment.kind) !== null
  );
}

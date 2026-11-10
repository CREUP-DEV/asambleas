import type { AmendmentKind, AmendmentStatus } from "../constants/domain";

/**
 * Reclassifying an amendment: the Secretaría moves it between "de forma"
 * (`formal`) and the usual content kind (`partial`). Both kinds carry the
 * same operations, so nothing else is stored to go back. Totality
 * amendments and transactionals are what they are and cannot be
 * reclassified.
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
 * a kind that has a counterpart, in a document not voted yet. Who may do it
 * (amendment:review) is checked apart.
 */
export function canReclassifyAmendment(
  amendment: { kind: AmendmentKind; status: AmendmentStatus },
  documentVoted: boolean,
): boolean {
  return (
    !documentVoted &&
    amendment.status === "submitted" &&
    reclassifyTarget(amendment.kind) !== null
  );
}

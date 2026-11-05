import type {
  AdmissionStatus,
  AmendmentStatus,
} from "~~/shared/constants/domain";
import type { AmendmentReviewState } from "~~/shared/types/api";

/**
 * Pure rules of the Secretaría's review (docs/design.md, "Validation by the
 * Secretaría and documentation tracking"), shared by the amendment endpoints,
 * the validation inbox and the home page. No database access here.
 */

export interface AmendmentReviewFields {
  status: AmendmentStatus;
  validatedAt: Date | null;
  publishedAt: Date | null;
  correctionRequestedAt: Date | null;
}

/**
 * Where an amendment stands for its authors and the Secretaría
 * (AmendmentReviewState). A draft is "correction_requested" only when the
 * Secretaría sent it back; a draft never presented has no review state.
 * An amendment settled before the Secretaría got to it (withdrawn, lapsed or
 * inadmissible without validation, or withdrawn after a private validation)
 * waits for nothing, so it has no review state either.
 */
export function amendmentReviewState(
  row: AmendmentReviewFields,
): AmendmentReviewState | null {
  if (row.status === "draft") {
    return row.correctionRequestedAt ? "correction_requested" : null;
  }
  if (row.publishedAt) return "published";
  if (awaitsValidation(row)) return "pending_validation";
  if (awaitsPublication(row)) return "validated";
  return null;
}

/** Presented and not checked yet: the Secretaría validates it or asks for a correction. */
export function awaitsValidation(
  row: Pick<AmendmentReviewFields, "status" | "validatedAt">,
): boolean {
  return row.status === "submitted" && row.validatedAt === null;
}

/**
 * Statuses that need no publication to be followed: a withdrawn or
 * inadmissible amendment that nobody else saw can stay private. They can
 * still be published on purpose (isAmendmentPublishable).
 */
export const SETTLED_PRIVATE_STATUSES: readonly AmendmentStatus[] = [
  "draft",
  "withdrawn",
  "inadmissible",
];

/**
 * Validated, not visible to everyone yet, and still relevant to the debate:
 * what the validation inbox and the home page list as "to publish".
 */
export function awaitsPublication(
  row: Pick<AmendmentReviewFields, "status" | "validatedAt" | "publishedAt">,
): boolean {
  return (
    row.validatedAt !== null &&
    row.publishedAt === null &&
    !SETTLED_PRIVATE_STATUSES.includes(row.status)
  );
}

/** POST .../amendments/publish accepts any validated, unpublished amendment past draft. */
export function isAmendmentPublishable(
  row: Pick<AmendmentReviewFields, "status" | "validatedAt" | "publishedAt">,
): boolean {
  return (
    row.status !== "draft" &&
    row.validatedAt !== null &&
    row.publishedAt === null
  );
}

/**
 * Admission set by the Secretaría's validation: an on-time amendment is
 * admitted at once, a late one keeps waiting for the Mesa's decision.
 */
export function admissionOnValidation(row: {
  late: boolean;
  admission: AdmissionStatus;
}): AdmissionStatus {
  return row.late ? row.admission : "admitted";
}

/**
 * Whether an admission decision has to wait for the Secretaría. The Mesa
 * decides on the admission of late amendments; an on-time amendment is
 * admitted by the Secretaría's validation, so admitting one that was never
 * validated would skip that check. A vote can end either way (a failed vote
 * to declare it inadmissible admits it), so no vote is taken on one either.
 * Declaring it inadmissible directly and re-admitting an inadmissible one
 * are not affected.
 */
export function admissionNeedsValidation(
  row: { status: string; late: boolean; validatedAt: Date | null },
  decision: "admitted" | "inadmissible",
  byVote: boolean,
): boolean {
  return (
    (decision === "admitted" || byVote) &&
    row.status === "submitted" &&
    !row.late &&
    row.validatedAt === null
  );
}

/**
 * Why an amendment cannot be grouped into (or absorbed by) a transactional,
 * or null when it can: it must be presented, admitted and undecided. Under
 * the Secretaría's validation the usual reason is an amendment still waiting
 * for it, or a late one still waiting for the Mesa's admission.
 */
export function unopenSourceReason(row: {
  status: AmendmentStatus;
  admission: AdmissionStatus;
  validatedAt: Date | null;
  decidedAt: Date | null;
}): "not_validated" | "not_admitted" | "decided" | null {
  if (row.status === "submitted" && !row.decidedAt) {
    if (row.admission === "admitted") return null;
    if (row.admission === "pending") {
      return row.validatedAt === null ? "not_validated" : "not_admitted";
    }
  }
  return "decided";
}

/** Messages for unopenSourceReason, in the order a reader should fix them. */
export const UNOPEN_SOURCE_MESSAGES: Record<
  NonNullable<ReturnType<typeof unopenSourceReason>>,
  string
> = {
  not_validated:
    "Alguna de las enmiendas que agrupa todavía no está validada por la Secretaría",
  not_admitted:
    "Alguna de las enmiendas que agrupa todavía no está admitida por la Mesa",
  decided: "Alguna de las enmiendas de origen ya está decidida",
};

/**
 * The message for a set of sources that are not all open, or null when they
 * all are. The most actionable reason wins: waiting for the Secretaría, then
 * for the Mesa, then already decided.
 */
export function unopenSourcesMessage(
  rows: Parameters<typeof unopenSourceReason>[0][],
): string | null {
  const reasons = new Set(rows.map(unopenSourceReason));
  for (const reason of ["not_validated", "not_admitted", "decided"] as const) {
    if (reasons.has(reason)) return UNOPEN_SOURCE_MESSAGES[reason];
  }
  return null;
}

/**
 * Whether presenting a draft makes it late. An amendment the Secretaría sent
 * back for correction keeps the timing of its first presentation, so fixing
 * it after the window closed does not turn it into a late one.
 */
export function submissionLate(
  previous: { late: boolean; correctionRequestedAt: Date | null },
  lateNow: boolean,
): boolean {
  return previous.correctionRequestedAt ? previous.late : lateNow;
}

/**
 * Numbering an amendment keeps when it is presented again after a
 * correction: its number per document always, and its per-member sequence
 * (and code) while the presenting member is the same. Null means a new one
 * is assigned, as on a first presentation.
 */
export function numberingToKeep(
  previous: {
    number: number | null;
    memberSeq: number | null;
    code: string | null;
  },
  presentingAcronym: string,
): { number: number | null; memberSeq: number | null } {
  const sameMember =
    previous.memberSeq !== null &&
    previous.code === `${presentingAcronym} ${previous.memberSeq}`;
  return {
    number: previous.number,
    memberSeq: sameMember ? previous.memberSeq : null,
  };
}

/** Counts per assembly for the Secretaría's summary on the home page. */
export interface ReviewCounts {
  documentsToValidate: number;
  amendmentsToValidate: number;
  amendmentsToPublish: number;
  documentsOverdue: number;
}

/** An expected document past its internal deadline that was not presented. */
export function isDocumentOverdue(
  document: { status: string; dueAt: Date | null },
  now = new Date(),
): boolean {
  return (
    document.status === "draft" &&
    document.dueAt !== null &&
    document.dueAt.getTime() < now.getTime()
  );
}

export function hasPendingReview(counts: ReviewCounts): boolean {
  return (
    counts.documentsToValidate +
      counts.amendmentsToValidate +
      counts.amendmentsToPublish +
      counts.documentsOverdue >
    0
  );
}

/**
 * Position of every agenda item in reading order: roots by `order`, each
 * followed by its sub-items, depth first. Items in a cycle or with a missing
 * parent come last, in `order`.
 */
export function agendaPositions(
  items: { id: string; parentId: string | null; order: number }[],
): Map<string, number> {
  const children = new Map<string | null, typeof items>();
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    const parent =
      item.parentId !== null && ids.has(item.parentId) ? item.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order);
  const position = new Map<string, number>();
  const visit = (parent: string | null) => {
    for (const item of children.get(parent) ?? []) {
      if (position.has(item.id)) continue;
      position.set(item.id, position.size);
      visit(item.id);
    }
  };
  visit(null);
  for (const item of [...items].sort((a, b) => a.order - b.order)) {
    if (!position.has(item.id)) position.set(item.id, position.size);
  }
  return position;
}

import type {
  AcceptanceDecision,
  AcceptanceRole,
  AdmissionStatus,
  AmendmentKind,
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
  /**
   * For a transactional, the answer of the document's presenter
   * (proponentApproval). Null or absent when no approval is needed.
   */
  proponentApproval?: AcceptanceDecision | null;
}

/**
 * The answer of the document's presenter to a transactional: the acceptance
 * row of the document's proponent member, whatever its role (when the
 * presenter also wrote a source, buildAcceptanceParties keeps a single row
 * with the role "author"). Null for other kinds, for documents without a
 * presenter and when the presenter is not a party.
 */
export function proponentApproval(
  amendment: {
    kind: AmendmentKind;
    acceptances: { memberId: string; decision: AcceptanceDecision }[];
  },
  proponentMemberId: string | null,
): AcceptanceDecision | null {
  if (amendment.kind !== "transactional" || !proponentMemberId) return null;
  return (
    amendment.acceptances.find(
      (acceptance) => acceptance.memberId === proponentMemberId,
    )?.decision ?? null
  );
}

/**
 * The role an acceptance row shows in AcceptanceDto: "proponent" for the
 * row of the document's presenter, also when it wrote one of the sources
 * (its single stored row then has the role "author"), so clients find the
 * presenter's answer by role; the stored role otherwise.
 */
export function partyRole(
  acceptance: { memberId: string; role: AcceptanceRole },
  proponentMemberId: string | null,
): AcceptanceRole {
  return proponentMemberId !== null && acceptance.memberId === proponentMemberId
    ? "proponent"
    : acceptance.role;
}

/**
 * Where an amendment stands for its authors and the Secretaría
 * (AmendmentReviewState). A draft is "correction_requested" only when the
 * Secretaría sent it back; a draft never presented has no review state.
 * A transactional presented by a member waits for the document's presenter
 * ("pending_proponent") before the Secretaría checks it, and stays there if
 * the presenter rejects it (the rejection shows in its acceptances).
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
  if (awaitsProponent(row)) return "pending_proponent";
  if (awaitsValidation(row)) return "pending_validation";
  if (awaitsPublication(row)) return "validated";
  return null;
}

/**
 * A transactional presented by a member that the document's presenter has
 * not approved (still pending, or rejected): the Secretaría does not check
 * it until the presenter accepts it. One the Mesa presents is validated at
 * once, so it never waits here.
 */
export function awaitsProponent(
  row: Pick<
    AmendmentReviewFields,
    "status" | "validatedAt" | "proponentApproval"
  >,
): boolean {
  return (
    row.status === "submitted" &&
    row.validatedAt === null &&
    (row.proponentApproval === "pending" ||
      row.proponentApproval === "rejected")
  );
}

/**
 * Presented and not checked yet: the Secretaría validates it or asks for a
 * correction. A transactional still waiting for the presenter's approval
 * (awaitsProponent) is not its turn yet.
 */
export function awaitsValidation(
  row: Pick<
    AmendmentReviewFields,
    "status" | "validatedAt" | "proponentApproval"
  >,
): boolean {
  return (
    row.status === "submitted" &&
    row.validatedAt === null &&
    !awaitsProponent(row)
  );
}

/**
 * A transactional proposed by a member whose presenter has not answered yet
 * (proponentApproval "pending"). The validation inbox lists it, read only,
 * so the Secretaría sees what is about to reach it; one the presenter
 * rejected waits for nobody but its proposer, so it is left out.
 */
export function awaitsProponentAnswer(
  row: Pick<
    AmendmentReviewFields,
    "status" | "validatedAt" | "proponentApproval"
  >,
): boolean {
  return awaitsProponent(row) && row.proponentApproval === "pending";
}

/**
 * Presented after its deadline and validated by the Secretaría, published
 * or not, while the assembly has not decided whether to treat it
 * (admission still pending): the Secretaría or the Mesa records that
 * decision (POST .../amendments/admission).
 */
export function awaitsAssemblyDecision(row: {
  status: AmendmentStatus;
  late: boolean;
  admission: AdmissionStatus;
  validatedAt: Date | null;
}): boolean {
  return (
    row.late &&
    row.admission === "pending" &&
    row.status === "submitted" &&
    row.validatedAt !== null
  );
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
 * Validated, not visible to everyone yet, and still relevant to the debate.
 * The validation inbox lists these as "to publish", except the late ones
 * still waiting for the assembly's decision (awaitsAssemblyDecision), which
 * it lists with the late ones; the home page counts them the same way.
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
 * for it, or a late one still waiting for the assembly to decide whether it
 * is treated (validated with its admission pending: an on-time amendment is
 * admitted by its validation).
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
    "Alguna de las enmiendas que agrupa está fuera de plazo y la asamblea todavía no ha decidido si se trata",
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
 * Why an amendment cannot be a direct source of a new transactional, or
 * null when it can: on top of being open (unopenSourceReason), it must be
 * published, since a transactional builds on what everyone can read.
 * Publication is never undone, so the check holds once passed.
 */
export function transactionalSourceReason(row: {
  status: AmendmentStatus;
  admission: AdmissionStatus;
  validatedAt: Date | null;
  decidedAt: Date | null;
  publishedAt: Date | null;
}): "not_validated" | "not_admitted" | "not_published" | "decided" | null {
  return unopenSourceReason(row) ?? (row.publishedAt ? null : "not_published");
}

/** Messages for transactionalSourceReason. */
export const TRANSACTIONAL_SOURCE_MESSAGES: Record<
  NonNullable<ReturnType<typeof transactionalSourceReason>>,
  string
> = {
  ...UNOPEN_SOURCE_MESSAGES,
  not_published:
    "Alguna de las enmiendas que agrupa todavía no está publicada por la Secretaría",
};

/**
 * The message for the direct sources of a new transactional that cannot all
 * be grouped, or null when they can. As in unopenSourcesMessage, the most
 * actionable reason wins.
 */
export function transactionalSourcesMessage(
  rows: Parameters<typeof transactionalSourceReason>[0][],
): string | null {
  const reasons = new Set(rows.map(transactionalSourceReason));
  for (const reason of [
    "not_validated",
    "not_admitted",
    "not_published",
    "decided",
  ] as const) {
    if (reasons.has(reason)) return TRANSACTIONAL_SOURCE_MESSAGES[reason];
  }
  return null;
}

/**
 * What the presenter of a published document still has to answer (its
 * review mode, MeWorkProponentDto), over the amendments it can see:
 * - `positionsPending`: presented, undecided amendments without a position
 *   yet, once the Secretaría checked them (validated or published; one
 *   still "pending_validation" is not the presenter's turn yet, as in its
 *   review mode). Transactionals are left out: the presenter answers them
 *   with its acceptance;
 * - `transactionalsToApprove`: presented transactionals whose acceptance by
 *   the presenter (proponentApproval) is still pending.
 */
export function countProponentWork(
  rows: {
    kind: AmendmentKind;
    status: AmendmentStatus;
    validatedAt: Date | null;
    publishedAt: Date | null;
    /** The presenter's position, null when there is no position row. */
    position: string | null;
    acceptances: { memberId: string; decision: AcceptanceDecision }[];
  }[],
  proponentMemberId: string,
): { positionsPending: number; transactionalsToApprove: number } {
  let positionsPending = 0;
  let transactionalsToApprove = 0;
  for (const row of rows) {
    if (row.status !== "submitted") continue;
    if (row.kind === "transactional") {
      if (proponentApproval(row, proponentMemberId) === "pending") {
        transactionalsToApprove += 1;
      }
    } else if (row.validatedAt === null && row.publishedAt === null) {
      // Still waiting for the Secretaría ("pending_validation").
      continue;
    } else if (row.position === null || row.position === "pending") {
      positionsPending += 1;
    }
  }
  return { positionsPending, transactionalsToApprove };
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

import type {
  AcceptanceDecision,
  AcceptanceRole,
  AcceptedAmendmentRule,
  AdmissionStatus,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  ProponentPosition,
} from "~~/shared/constants/domain";
import type { AmendmentReviewState } from "~~/shared/types/api";

/**
 * Pure rules of the Secretaría's review (docs/design.md, "Validation by the
 * Secretaría and documentation tracking") and of the amendment flow
 * ("Reviewing amendments, transactionals and the session"), shared by the
 * amendment endpoints, the validation inbox and the home page. No database
 * access here.
 */

export interface AmendmentReviewFields {
  status: AmendmentStatus;
  validatedAt: Date | null;
  publishedAt: Date | null;
  correctionRequestedAt: Date | null;
  /**
   * For a transactional, the answer of the main authors of the amendments
   * it would replace (authorsApproval). Null or absent for other kinds.
   */
  authorsApproval?: AcceptanceDecision | null;
}

/**
 * The answer of the main authors of the amendments a transactional would
 * replace, from its acceptance rows: "rejected" as soon as one rejected it,
 * "accepted" once every one accepted (or when there is nobody to ask), and
 * "pending" otherwise. Only rows with the role "author" count: rows with the
 * role "proponent" come from the earlier rule, when the document's presenter
 * approved transactionals, and are ignored. Null for other kinds.
 */
export function authorsApproval(amendment: {
  kind: AmendmentKind;
  acceptances: { role: AcceptanceRole; decision: AcceptanceDecision }[];
}): AcceptanceDecision | null {
  if (amendment.kind !== "transactional") return null;
  const parties = amendment.acceptances.filter(
    (acceptance) => acceptance.role === "author",
  );
  if (parties.some((party) => party.decision === "rejected")) return "rejected";
  return parties.every((party) => party.decision === "accepted")
    ? "accepted"
    : "pending";
}

/**
 * The main author of an amendment: the presenting member stored with it
 * (meta.presentingMemberId) while it is still one of its authors, the only
 * author otherwise, or the first by id for older rows with several authors
 * and none stored. Null when it has no authors (a transactional the Mesa
 * drafted for nobody in particular).
 */
export function mainAuthorOf(
  authorIds: readonly string[],
  presentingMemberId: string | null | undefined,
): string | null {
  if (presentingMemberId && authorIds.includes(presentingMemberId)) {
    return presentingMemberId;
  }
  return [...authorIds].sort()[0] ?? null;
}

/**
 * The main author chosen for a set of authors:
 * - the one requested, which must be one of them ("not_author");
 * - the only author when there is one;
 * - `current` (the stored main author of a draft being edited) while it is
 *   still one of them;
 * - otherwise "required": with several authors someone has to be named.
 * Null when there are no authors and none was requested.
 */
export function pickMainAuthor(
  authorIds: readonly string[],
  requested: string | null | undefined,
  current?: string | null,
): string | null | "not_author" | "required" {
  if (requested)
    return authorIds.includes(requested) ? requested : "not_author";
  if (authorIds.length === 0) return null;
  if (authorIds.length === 1) return authorIds[0]!;
  if (current && authorIds.includes(current)) return current;
  return "required";
}

/** Messages for the errors of pickMainAuthor. */
export const MAIN_AUTHOR_MESSAGES = {
  not_author: "El autor principal tiene que ser uno de los autores",
  required: "Indica quién es el autor principal de la enmienda",
} as const;

/**
 * Where an amendment stands for its authors and the Secretaría
 * (AmendmentReviewState). A draft is "correction_requested" only when the
 * Secretaría sent it back; a draft never presented has no review state.
 * A transactional proposed by a member waits for the main authors of the
 * amendments it would replace ("pending_authors") before the Secretaría
 * checks it.
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
  if (awaitsAuthors(row)) return "pending_authors";
  if (awaitsValidation(row)) return "pending_validation";
  if (awaitsPublication(row)) return "validated";
  return null;
}

/**
 * A transactional presented by a member that the main authors of the
 * amendments it would replace have not all accepted: the Secretaría does not
 * check it until they do. A rejection closes it (withdrawn), so in practice
 * it waits for answers still pending. One the Mesa presents is validated at
 * once, so it never waits here (its authors answer in the room).
 */
export function awaitsAuthors(
  row: Pick<
    AmendmentReviewFields,
    "status" | "validatedAt" | "authorsApproval"
  >,
): boolean {
  return (
    row.status === "submitted" &&
    row.validatedAt === null &&
    (row.authorsApproval === "pending" || row.authorsApproval === "rejected")
  );
}

/**
 * Presented and not checked yet: the Secretaría validates it or asks for a
 * correction. A transactional still waiting for its main authors
 * (awaitsAuthors) is not its turn yet.
 */
export function awaitsValidation(
  row: Pick<
    AmendmentReviewFields,
    "status" | "validatedAt" | "authorsApproval"
  >,
): boolean {
  return (
    row.status === "submitted" &&
    row.validatedAt === null &&
    !awaitsAuthors(row)
  );
}

/**
 * Whether a transactional replaces the amendments it groups now: validated
 * by the Secretaría (or presented by the Mesa) and accepted by every main
 * author, whichever comes last. From then on those amendments are
 * `transacted` and it follows the normal flow.
 */
export function replacesSources(row: {
  kind: AmendmentKind;
  status: AmendmentStatus;
  validatedAt: Date | null;
  authorsApproval: AcceptanceDecision | null;
}): boolean {
  return (
    row.kind === "transactional" &&
    row.status === "submitted" &&
    row.validatedAt !== null &&
    row.authorsApproval === "accepted"
  );
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
 * Whether a member still has to answer a transactional as one of its
 * parties (the main author of an amendment it groups): it is presented and
 * undecided, that member's answer is pending, everything it groups is still
 * open (`sourcesOpen`: once one is settled or replaced by another
 * transactional it is closed, or can no longer go through) and the
 * document is not voted. Drives `can.accept` and the home page's
 * acceptances (MeWorkDto.acceptances).
 */
export function awaitsPartyAnswer(input: {
  status: AmendmentStatus;
  memberId: string | null;
  /** Rows with the role "author" (the parties). */
  parties: readonly { memberId: string; decision: AcceptanceDecision }[];
  sourcesOpen: boolean;
  voted: boolean;
}): boolean {
  return (
    input.status === "submitted" &&
    !input.voted &&
    input.sourcesOpen &&
    input.memberId !== null &&
    input.parties.some(
      (party) =>
        party.memberId === input.memberId && party.decision === "pending",
    )
  );
}

/**
 * Whether the Secretaría's validation publishes an amendment: as it chose
 * (`requested`), except a transactional, which always is. Validating a
 * transactional makes it replace published amendments, so it cannot stay
 * private: delegates would see the originals replaced by nothing.
 */
export function publishOnValidation(
  row: { kind: AmendmentKind },
  requested: boolean,
): boolean {
  return requested || row.kind === "transactional";
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
 * Why an amendment cannot be replaced by a transactional, or null when it
 * can: it must be presented, admitted and undecided. Under the Secretaría's
 * validation the usual reason is an amendment still waiting for it, or a
 * late one still waiting for the assembly to decide whether it is treated
 * (validated with its admission pending: an on-time amendment is admitted by
 * its validation).
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
 * published, since a transactional builds on what everyone can read
 * (publication is never undone, so the check holds once passed), and a
 * transactional must already have replaced what it groups (its main authors
 * accepted it), or its originals would survive next to the new one.
 */
export function transactionalSourceReason(row: {
  status: AmendmentStatus;
  admission: AdmissionStatus;
  validatedAt: Date | null;
  decidedAt: Date | null;
  publishedAt: Date | null;
  authorsApproval?: AcceptanceDecision | null;
}):
  | "not_validated"
  | "not_admitted"
  | "awaits_authors"
  | "not_published"
  | "decided"
  | null {
  const reason = unopenSourceReason(row);
  if (reason) return reason;
  if (row.authorsApproval === "pending" || row.authorsApproval === "rejected") {
    return "awaits_authors";
  }
  return row.publishedAt ? null : "not_published";
}

/** Messages for transactionalSourceReason. */
export const TRANSACTIONAL_SOURCE_MESSAGES: Record<
  NonNullable<ReturnType<typeof transactionalSourceReason>>,
  string
> = {
  ...UNOPEN_SOURCE_MESSAGES,
  awaits_authors:
    "Alguna de las enmiendas que agrupa es una transaccional que sus autores principales todavía no han aceptado",
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
    "awaits_authors",
    "not_published",
    "decided",
  ] as const) {
    if (reasons.has(reason)) return TRANSACTIONAL_SOURCE_MESSAGES[reason];
  }
  return null;
}

/**
 * Why the main presenter (or the Mesa for it) cannot answer an amendment
 * now, or null when it can (docs/design.md, "Amendment flow"): it must be
 * presented and undecided, validated by the Secretaría and, when it came
 * late, admitted by the assembly; a transactional must also be accepted by
 * every main author of what it replaces; and it must be published, so the
 * answer is about something every delegate can read. Under the
 * "incorporate" rule an amendment the presenter's acceptance approved
 * (approval method "proponent") can still be answered: changing the answer
 * reopens it. Once the document's final vote is recorded (`voted`) no
 * answer changes any more.
 */
export function positionBlocker(
  row: {
    status: AmendmentStatus;
    admission: AdmissionStatus;
    validatedAt: Date | null;
    publishedAt: Date | null;
    approvalMethod: ApprovalMethod | null;
    authorsApproval?: AcceptanceDecision | null;
  },
  rule: AcceptedAmendmentRule,
  voted = false,
):
  | "voted"
  | "decided"
  | "not_validated"
  | "not_admitted"
  | "awaits_authors"
  | "not_published"
  | null {
  if (voted) return "voted";
  if (
    rule === "incorporate" &&
    row.status === "approved" &&
    row.approvalMethod === "proponent"
  ) {
    return null;
  }
  if (row.status !== "submitted") return "decided";
  if (row.admission !== "admitted") {
    return row.validatedAt === null ? "not_validated" : "not_admitted";
  }
  if (row.authorsApproval === "pending" || row.authorsApproval === "rejected") {
    return "awaits_authors";
  }
  return row.publishedAt === null ? "not_published" : null;
}

/** Messages for positionBlocker. */
export const POSITION_BLOCKER_MESSAGES: Record<
  NonNullable<ReturnType<typeof positionBlocker>>,
  string
> = {
  voted: "El documento ya se ha votado: las respuestas ya no se pueden cambiar",
  decided: "Esta enmienda ya está decidida",
  not_validated:
    "La Secretaría todavía no ha validado esta enmienda: podrás responderla cuando lo haga",
  not_admitted:
    "Esta enmienda llegó fuera de plazo y la asamblea todavía no ha decidido si se trata",
  awaits_authors:
    "Los autores principales de las enmiendas que sustituye todavía no han aceptado esta transaccional",
  not_published:
    "La Secretaría todavía no ha publicado esta enmienda: podrás responderla cuando lo haga",
};

/**
 * Who recorded the main presenter's answer (PositionDto.recordedBy): the
 * main presenter itself, or the Mesa on its behalf. The amendment's latest
 * `position_changed` event says it as it was when recorded (`by`:
 * "moderator" is the Mesa), so an answer keeps its author when the document
 * later gets another main presenter. With no such event, it falls back to
 * comparing the member of the user who recorded it
 * (amendment_positions.decidedByUserId) with the document's current main
 * presenter. The row created as pending on submission has nobody behind it,
 * and neither has one whose user was deleted: both count as the
 * presenter's unless the event says otherwise.
 */
export function positionRecordedBy(input: {
  decidedByUserId: string | null;
  /** `by` of the amendment's latest position_changed event, if any. */
  recordedAs?: unknown;
  /** The member the recording user acts for, null or unknown when none. */
  recorderMemberId: string | null | undefined;
  mainPresenterId: string | null;
}): "presenter" | "mesa" {
  if (input.recordedAs === "moderator") return "mesa";
  if (input.recordedAs === "proponent") return "presenter";
  if (!input.decidedByUserId) return "presenter";
  return input.recorderMemberId &&
    input.recorderMemberId === input.mainPresenterId
    ? "presenter"
    : "mesa";
}

/**
 * What a new answer of the main presenter does to the amendment, beyond
 * recording it. Under the "incorporate" rule, accepting an undecided
 * amendment approves it at once (approval method "proponent") and moving an
 * amendment approved that way away from "accept" reopens it (back to
 * submitted). Under "vote" an answer never decides anything.
 */
export function positionEffect(
  row: { status: AmendmentStatus; approvalMethod: ApprovalMethod | null },
  position: ProponentPosition,
  rule: AcceptedAmendmentRule,
): "approve" | "reopen" | null {
  if (rule !== "incorporate") return null;
  if (row.status === "submitted" && position === "accept") return "approve";
  if (
    row.status === "approved" &&
    row.approvalMethod === "proponent" &&
    position !== "accept"
  ) {
    return "reopen";
  }
  return null;
}

/**
 * What changing a document's rule for accepted amendments
 * (documents.acceptedAmendments) does to the amendments already answered,
 * so the rule always says what an accepted amendment is:
 * - to "incorporate": every undecided amendment the main presenter already
 *   accepted and that it could answer now (positionBlocker: published
 *   among the rest) is approved at once (approval method "proponent"), as
 *   if accepted under that rule. A transactional must have replaced its
 *   sources (`keepsSources`, only a transactional presented under the
 *   earlier rule, which the Mesa approves);
 * - to "vote": every amendment the presenter's acceptance approved goes
 *   back to undecided, keeping the answer, for the assembly to vote.
 * Ids in input order.
 */
export function acceptedRulePlan(
  rows: {
    id: string;
    status: AmendmentStatus;
    admission: AdmissionStatus;
    validatedAt: Date | null;
    publishedAt: Date | null;
    approvalMethod: ApprovalMethod | null;
    authorsApproval: AcceptanceDecision | null;
    /** The main presenter's answer, null when there is no position row. */
    position: ProponentPosition | null;
    keepsSources?: boolean;
  }[],
  rule: AcceptedAmendmentRule,
): { approve: string[]; reopen: string[] } {
  if (rule === "incorporate") {
    return {
      approve: rows
        .filter(
          (row) =>
            row.position === "accept" &&
            positionEffect(row, "accept", rule) === "approve" &&
            positionBlocker(row, rule) === null &&
            !row.keepsSources,
        )
        .map((row) => row.id),
      reopen: [],
    };
  }
  return {
    approve: [],
    reopen: rows
      .filter(
        (row) =>
          row.status === "approved" && row.approvalMethod === "proponent",
      )
      .map((row) => row.id),
  };
}

/**
 * Why the Mesa cannot reopen a decided transactional, or null when it can
 * (POST .../outcome, "reopen"):
 * - `rejected_by_author`: a main author of what it groups rejected it,
 *   which closed it for good; the originals carried on, and a new
 *   transactional is the way to try again;
 * - `sources_closed`: it never replaced what it groups (not validated, or
 *   not accepted by every main author) and one of those amendments is no
 *   longer open (decided, or replaced by another transactional), so it
 *   could never go through.
 * A transactional that did replace its sources keeps them `transacted` and
 * can be reopened. Null for other kinds.
 */
export function transactionalReopenBlocker(row: {
  kind: AmendmentKind;
  validatedAt: Date | null;
  authorsApproval: AcceptanceDecision | null;
  sources: Parameters<typeof unopenSourceReason>[0][];
}): "rejected_by_author" | "sources_closed" | null {
  if (row.kind !== "transactional") return null;
  if (row.authorsApproval === "rejected") return "rejected_by_author";
  const replaced =
    row.validatedAt !== null && row.authorsApproval === "accepted";
  if (replaced) return null;
  return row.sources.some((source) => unopenSourceReason(source) !== null)
    ? "sources_closed"
    : null;
}

/** Messages for transactionalReopenBlocker. */
export const TRANSACTIONAL_REOPEN_MESSAGES: Record<
  NonNullable<ReturnType<typeof transactionalReopenBlocker>>,
  string
> = {
  rejected_by_author:
    "Un autor principal de las enmiendas que agrupa rechazó esta transaccional: para retomarla, propón una nueva",
  sources_closed:
    "Alguna de las enmiendas que agrupa ya está decidida o la sustituye otra transaccional: esta ya no se puede reabrir",
};

/**
 * How many amendments the main presenter of a published document still has
 * to answer (its review mode, MeWorkProponentDto.positionsPending), over the
 * amendments it can see: presented, undecided, without an answer yet, and
 * answerable now (positionBlocker), which needs them published: a validated
 * one the Secretaría keeps private waits until it publishes it, under
 * either rule.
 */
export function countPositionsPending(
  rows: {
    status: AmendmentStatus;
    admission: AdmissionStatus;
    validatedAt: Date | null;
    publishedAt: Date | null;
    approvalMethod: ApprovalMethod | null;
    authorsApproval: AcceptanceDecision | null;
    /** The main presenter's answer, null when there is no position row. */
    position: ProponentPosition | null;
  }[],
  rule: AcceptedAmendmentRule,
): number {
  return rows.filter(
    (row) =>
      row.status === "submitted" &&
      (row.position === null || row.position === "pending") &&
      positionBlocker(row, rule) === null,
  ).length;
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
 * is assigned, as on a first presentation. `codePrefix` is what the code of
 * the presenting member starts with (amendmentCodePrefix): its acronym, or
 * "CEA" for every executive area, which share one sequence.
 */
export function numberingToKeep(
  previous: {
    number: number | null;
    memberSeq: number | null;
    code: string | null;
  },
  codePrefix: string,
): { number: number | null; memberSeq: number | null } {
  const sameMember =
    previous.memberSeq !== null &&
    previous.code === `${codePrefix} ${previous.memberSeq}`;
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

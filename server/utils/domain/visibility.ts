import type {
  AmendmentStatus,
  AssemblySettings,
  AssemblyStatus,
  DecisionKind,
  DocumentStatus,
} from "~~/shared/constants/domain";
import type { DecisionDto } from "~~/shared/types/api";
import {
  actsFor,
  canManageAssemblies,
  canManageDocuments,
  canModerate,
  canReviewAmendments,
  type Actor,
} from "./actor";

/** Draft assemblies are only visible to those who manage assemblies. */
export function canSeeAssembly(
  actor: Actor,
  assembly: { status: AssemblyStatus },
): boolean {
  return (
    assembly.status !== "draft" ||
    canManageAssemblies(actor) ||
    canModerate(actor)
  );
}

/**
 * Published documents are public. Submissions under review and withdrawn
 * documents are visible to their proponent, the user who submitted them,
 * managers and the Mesa. Drafts are private: only their proponent, the user
 * who created them and managers (document:manage) see them.
 */
export function canSeeDocument(
  actor: Actor,
  document: {
    status: DocumentStatus;
    proponentMemberId: string | null;
    submittedByUserId: string | null;
  },
): boolean {
  if (document.status === "published" || document.status === "postponed")
    return true;
  if (canManageDocuments(actor)) return true;
  if (document.status !== "draft" && canModerate(actor)) return true;
  if (document.submittedByUserId === actor.user.id) return true;
  return actsFor(actor, [document.proponentMemberId]);
}

export function isDocumentProponent(
  actor: Actor,
  document: { proponentMemberId: string | null },
): boolean {
  return actsFor(actor, [document.proponentMemberId]);
}

export interface AmendmentVisibilityContext {
  status: AmendmentStatus;
  late: boolean;
  createdByUserId: string | null;
  authorMemberIds: string[];
  /** For transactionals: authors of the parents and the proponent. */
  partyMemberIds: string[];
}

/**
 * Whether the presented amendments of a document are public under the
 * `after_close` policy: the window was closed by date, it has no close date
 * at all, or the assembly is already in session (or closed), where the Mesa
 * debates and projects them. This is not the `late` flag, which keeps using
 * `isLateSubmission`.
 */
export function amendmentsPublic(
  window: { closesAt: Date | null },
  assemblyStatus: AssemblyStatus,
  now = new Date(),
): boolean {
  if (assemblyStatus === "in_session" || assemblyStatus === "closed")
    return true;
  return !window.closesAt || now > window.closesAt;
}

export interface AmendmentVisibilityOptions {
  settings: AssemblySettings;
  /** Whether the document's amendments are public (`amendmentsPublic`). */
  windowClosed: boolean;
}

/**
 * Whether the actor sees every presented (non-draft) amendment of a document
 * without being one of its authors: the `after_close` policy does not hide
 * them (another policy, or the amendments are public already), or the actor
 * reviews amendments or sits at the Mesa. Callers use it to skip the
 * per-amendment rule of `canSeeAmendment`.
 */
export function seesAllPresentedAmendments(
  actor: Actor,
  options: AmendmentVisibilityOptions,
): boolean {
  return (
    options.settings.amendmentVisibility !== "after_close" ||
    options.windowClosed ||
    canReviewAmendments(actor) ||
    canModerate(actor)
  );
}

/**
 * - Drafts: their authors, the parties of a transactional, and reviewers
 *   (amendment:review or amendment:manage). The Mesa alone does not read
 *   members' private drafts; the drafts it creates itself are covered by
 *   `createdByUserId`.
 * - Under `after_close`, while amendments are not public yet
 *   (`windowClosed`, see `amendmentsPublic`), every presented amendment
 *   (submitted, withdrawn, inadmissible...) is visible only to its authors,
 *   the parties of a transactional, reviewers and the Mesa.
 * - Everything else: everyone who can see the document.
 */
export function canSeeAmendment(
  actor: Actor,
  amendment: AmendmentVisibilityContext,
  options: AmendmentVisibilityOptions,
): boolean {
  const isAuthor =
    amendment.createdByUserId === actor.user.id ||
    actsFor(actor, amendment.authorMemberIds) ||
    actsFor(actor, amendment.partyMemberIds);
  if (amendment.status === "draft") {
    return isAuthor || canReviewAmendments(actor);
  }
  return isAuthor || seesAllPresentedAmendments(actor, options);
}

/** Decision kinds whose `subjectIds` are amendment ids. */
const AMENDMENT_DECISION_KINDS: ReadonlySet<DecisionKind> = new Set([
  "admit_late",
  "inadmission",
]);

/** Amendment ids named by admission decisions (`admit_late`, `inadmission`). */
export function decisionAmendmentIds(decisions: DecisionDto[]): string[] {
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (!AMENDMENT_DECISION_KINDS.has(decision.kind)) continue;
    for (const id of decision.subjectIds) ids.add(id);
  }
  return [...ids];
}

/**
 * Decisions as the actor may read them. An admission decision keeps only the
 * amendments the actor can see in `subjectIds` and is dropped when it names
 * none of them, so its note and vote do not reveal amendments that are still
 * private (`after_close`). A decision that keeps at least one subject keeps
 * its note: it is the reason its visible amendment was admitted or refused.
 * Other kinds are returned unchanged.
 */
export function filterDecisionsByAmendment(
  decisions: DecisionDto[],
  isVisible: (amendmentId: string) => boolean,
): DecisionDto[] {
  const result: DecisionDto[] = [];
  for (const decision of decisions) {
    if (!AMENDMENT_DECISION_KINDS.has(decision.kind)) {
      result.push(decision);
      continue;
    }
    const subjectIds = decision.subjectIds.filter(isVisible);
    if (subjectIds.length === 0) continue;
    result.push(
      subjectIds.length === decision.subjectIds.length
        ? decision
        : { ...decision, subjectIds },
    );
  }
  return result;
}

/** Who sees the proponent's position on amendments. */
export function canSeePositions(
  actor: Actor,
  options: {
    settings: AssemblySettings;
    assemblyStatus: AssemblyStatus;
    isProponent: boolean;
  },
): boolean {
  if (options.isProponent || canModerate(actor) || canReviewAmendments(actor))
    return true;
  if (options.settings.positionVisibility === "public") return true;
  return (
    options.settings.positionVisibility === "session" &&
    (options.assemblyStatus === "in_session" ||
      options.assemblyStatus === "closed")
  );
}

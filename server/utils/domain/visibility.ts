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
  /** Set by the Secretaría: the amendment is visible to everyone. */
  publishedAt: Date | null;
  createdByUserId: string | null;
  authorMemberIds: string[];
  /** For transactionals: authors of the parents and the proponent. */
  partyMemberIds: string[];
}

/**
 * Whether the actor sees every presented (non-draft) amendment, published or
 * not: the Secretaría (amendment:review or amendment:manage) and the Mesa.
 * Callers use it to skip the per-amendment rule of `canSeeAmendment`.
 */
export function seesAllPresentedAmendments(actor: Actor): boolean {
  return canReviewAmendments(actor) || canModerate(actor);
}

/** The actor wrote the amendment, created it or is a party of the transactional. */
export function isAmendmentInsider(
  actor: Actor,
  amendment: Pick<
    AmendmentVisibilityContext,
    "createdByUserId" | "authorMemberIds" | "partyMemberIds"
  >,
): boolean {
  return (
    amendment.createdByUserId === actor.user.id ||
    actsFor(actor, amendment.authorMemberIds) ||
    actsFor(actor, amendment.partyMemberIds)
  );
}

/**
 * Who sees an amendment of a document the actor can see. Visibility is per
 * amendment: the Secretaría publishes each one, when validating it or later.
 * - Drafts: their authors, the user who created them, the parties of a
 *   transactional and reviewers (amendment:review or amendment:manage). The
 *   Mesa alone does not read members' private drafts; the drafts it creates
 *   itself are covered by `createdByUserId`.
 * - Presented and published (`publishedAt`): everyone.
 * - Presented, not published yet (waiting for validation, validated but kept
 *   private, or decided before publication): its authors, its creator, the
 *   parties of a transactional, reviewers and the Mesa.
 */
export function canSeeAmendment(
  actor: Actor,
  amendment: AmendmentVisibilityContext,
): boolean {
  const insider = isAmendmentInsider(actor, amendment);
  if (amendment.status === "draft") {
    return insider || canReviewAmendments(actor);
  }
  if (amendment.publishedAt) return true;
  return insider || seesAllPresentedAmendments(actor);
}

/** Event types whose payload carries a correction note (`note`). */
const CORRECTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "document_correction_requested",
  "amendment_correction_requested",
]);

/**
 * Correction notes are meant for the presenters and the Secretaría or Mesa
 * only (correctionNote in the DTOs). The history keeps them in the payload,
 * so they are removed for everyone else, even after publication.
 */
export function redactCorrectionNote(
  type: string,
  payload: Record<string, unknown>,
  noteVisible: boolean,
): Record<string, unknown> {
  if (noteVisible || !CORRECTION_EVENT_TYPES.has(type) || !("note" in payload))
    return payload;
  const rest = { ...payload };
  delete rest.note;
  return rest;
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
 * private (not published). A decision that keeps at least one subject keeps
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

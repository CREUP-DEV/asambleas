import type {
  AmendmentStatus,
  AssemblySettings,
  AssemblyStatus,
  DocumentStatus,
} from "~~/shared/constants/domain";
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
 * Published documents are public. Drafts and submissions under review are
 * visible to their proponent, the user who submitted them and managers.
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
  if (canManageDocuments(actor) || canModerate(actor)) return true;
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
  /** For transactional drafts: authors of the parents and the proponent. */
  partyMemberIds: string[];
}

/**
 * - Drafts: their authors, the parties of a transactional, and managers.
 * - Submitted amendments while the window is open, when the assembly
 *   publishes them on close: authors and managers only.
 * - Everything else: everyone who can see the document.
 */
export function canSeeAmendment(
  actor: Actor,
  amendment: AmendmentVisibilityContext,
  options: { settings: AssemblySettings; windowClosed: boolean },
): boolean {
  const privileged = canReviewAmendments(actor) || canModerate(actor);
  const isAuthor =
    amendment.createdByUserId === actor.user.id ||
    actsFor(actor, amendment.authorMemberIds);
  if (amendment.status === "draft") {
    return privileged || isAuthor || actsFor(actor, amendment.partyMemberIds);
  }
  if (
    amendment.status === "submitted" &&
    options.settings.amendmentVisibility === "after_close" &&
    !options.windowClosed
  ) {
    return privileged || isAuthor;
  }
  return true;
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

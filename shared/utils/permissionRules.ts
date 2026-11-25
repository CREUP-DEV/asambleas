import {
  PERMISSION_KEYS,
  holdsPermission,
  readsControlSheet,
  type PermissionCheck,
} from "../constants/permissions";

/**
 * Permission rules that depend only on the keys an account holds, written
 * once for the server and the client (ARQ-11): the server passes
 * `actor.can`, the client `useMe().can`. A rule of this kind lives here and
 * nowhere else; `dto.can.*` stays for what depends on the object (status,
 * authorship, presenters). Implied keys (PERMISSION_IMPLIED_BY) are read
 * through `holdsPermission`, never with an OR of their own.
 */

export { holdsPermission, readsControlSheet, type PermissionCheck };

/** The Mesa de Moderación: live state, admissions, outcomes, votes. */
export function moderates(can: PermissionCheck): boolean {
  return can(PERMISSION_KEYS.SESSION_MODERATE);
}

/**
 * Recording results (user's decision of 2026-11-19), from the console or
 * the control sheet: the Mesa and whoever holds assembly:vote_result.
 */
export function recordsResults(can: PermissionCheck): boolean {
  return moderates(can) || can(PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT);
}

/**
 * Noting who spoke (user's decision of 2026-11-19), from the live view and
 * the control sheet: the Mesa and whoever holds session:record_speakers.
 */
export function notesSpeakers(can: PermissionCheck): boolean {
  return moderates(can) || can(PERMISSION_KEYS.SESSION_RECORD_SPEAKERS);
}

/** Reading the room (Sala): seating:view, or seating:edit, which holds it. */
export function viewsSeating(can: PermissionCheck): boolean {
  return holdsPermission(can, PERMISSION_KEYS.SEATING_VIEW);
}

/** Validating documents and following their tracking: document:manage. */
export function validatesDocuments(can: PermissionCheck): boolean {
  return can(PERMISSION_KEYS.DOCUMENT_MANAGE);
}

/**
 * Validating amendments: amendment:review, or amendment:manage, which holds
 * it.
 */
export function reviewsAmendments(can: PermissionCheck): boolean {
  return holdsPermission(can, PERMISSION_KEYS.AMENDMENT_REVIEW);
}

/**
 * The validation inbox («Validación», GET .../review): whoever validates
 * documents or amendments; each part shows only to whoever holds it.
 */
export function usesReviewQueue(can: PermissionCheck): boolean {
  return validatesDocuments(can) || reviewsAmendments(can);
}

/** Draft assemblies: whoever manages assemblies and the Mesa. */
export function seesDraftAssemblies(can: PermissionCheck): boolean {
  return can(PERMISSION_KEYS.ASSEMBLY_MANAGE) || moderates(can);
}

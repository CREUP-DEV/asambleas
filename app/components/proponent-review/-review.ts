/**
 * Pure helpers behind the presenter's review mode
 * (/asambleas/<slug>/documentos/<doc>/revisar): which amendments wait for an
 * answer, the order they are shown in, the progress line and the cursor that
 * moves through them. No Nuxt or Vue APIs here, so they are unit-tested on
 * their own (-review.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */
import type { ProponentPosition } from "~~/shared/constants/domain";
import type { AcceptanceDto, AmendmentDto } from "~~/shared/types/api";
import {
  isAmendmentOpen,
  sortAmendments,
} from "~/composables/amendment/workspace";

/** What the step asks: approve a transactional, or answer an amendment. */
export type ProponentReviewKind = "transactional" | "position";

/** The answers the presenter can give to an amendment. */
export type ProponentAnswer = Exclude<ProponentPosition, "pending">;

export const PROPONENT_ANSWERS: readonly ProponentAnswer[] = [
  "accept",
  "reject",
  "transact",
];

export interface ProponentReviewItem {
  id: string;
  kind: ProponentReviewKind;
  amendment: AmendmentDto;
  /**
   * The presenter already answered (a position other than pending). A
   * transactional is listed only while its approval is pending.
   */
  answered: boolean;
}

/** Who answers a transactional's approval, and for whom. */
export interface AcceptanceTarget {
  /** The document presenter's row among the transactional's parties. */
  party: AcceptanceDto;
  /**
   * The member to name in AcceptanceBody.memberId: null when the actor
   * answers for their own member, the presenter's member when the Mesa
   * records the answer for it.
   */
  memberId: string | null;
}

// Positions --------------------------------------------------------------------

/** The presenter has given a position (a null position counts as pending). */
export function isPositionAnswered(
  amendment: Pick<AmendmentDto, "position">,
): boolean {
  return (
    amendment.position !== null && amendment.position.position !== "pending"
  );
}

/** The answer given, or null while it is pending. */
export function positionAnswer(
  amendment: Pick<AmendmentDto, "position">,
): ProponentAnswer | null {
  const value = amendment.position?.position;
  return value && value !== "pending" ? value : null;
}

/**
 * An amendment the presenter (or the Mesa for it) answers here: presented,
 * not decided, published by the Secretaría, and not a transactional (those
 * are approved through their acceptance instead). Only published ones: an
 * amendment validated but kept private is hidden from the presenter
 * (canSeeAmendment), so the Mesa does not answer for it on a text it has
 * never read, and both see the same count.
 */
export function isPositionReviewable(
  amendment: Pick<AmendmentDto, "status" | "kind" | "reviewState"> & {
    can: Pick<AmendmentDto["can"], "position">;
  },
): boolean {
  return (
    amendment.status === "submitted" &&
    amendment.kind !== "transactional" &&
    amendment.can.position &&
    amendment.reviewState === "published"
  );
}

/**
 * The comment typed differs from the saved one (both trimmed, as the server
 * stores it). A comment typed and then put back is not a change.
 */
export function commentUnsaved(
  draft: string | undefined,
  saved: string | null | undefined,
): boolean {
  if (draft === undefined) return false;
  return draft.trim() !== (saved ?? "").trim();
}

// Transactionals ------------------------------------------------------------------

/**
 * The document presenter's row among a transactional's parties, if any.
 * Found by member, as the server does (proponentApproval): when the
 * presenter also wrote one of the amendments it groups, its single row has
 * the role "author". The role "proponent" is a fallback only when the
 * presenter is unknown.
 */
export function proponentAcceptance(
  amendment: Pick<AmendmentDto, "acceptances">,
  proponentMemberId: string | null,
): AcceptanceDto | null {
  if (proponentMemberId === null) {
    return (
      amendment.acceptances.find(
        (acceptance) => acceptance.role === "proponent",
      ) ?? null
    );
  }
  return (
    amendment.acceptances.find(
      (acceptance) => acceptance.member.id === proponentMemberId,
    ) ?? null
  );
}

/**
 * A transactional waiting for the document's presenter: proposed by a member
 * and not passed to the Secretaría yet ("pending_proponent"), or presented
 * (by the Mesa, in session) with the presenter's answer still pending.
 */
export function awaitsProponentApproval(
  amendment: Pick<
    AmendmentDto,
    "kind" | "status" | "reviewState" | "acceptances"
  >,
  proponentMemberId: string | null,
): boolean {
  if (amendment.kind !== "transactional" || !isAmendmentOpen(amendment)) {
    return false;
  }
  const party = proponentAcceptance(amendment, proponentMemberId);
  if (party?.decision !== "pending") return false;
  return (
    amendment.reviewState === "pending_proponent" ||
    amendment.status === "submitted"
  );
}

/**
 * Whether the actor can answer the presenter's approval, and how: the
 * presenter answers for itself (`can.accept`), the Mesa records the answer
 * for the presenter's member (`can.moderate`). Null when the actor cannot.
 */
export function acceptanceTarget(
  amendment: Pick<AmendmentDto, "acceptances"> & {
    can: Pick<AmendmentDto["can"], "accept" | "moderate">;
  },
  actorMemberId: string | null,
  proponentMemberId: string | null,
): AcceptanceTarget | null {
  const party = proponentAcceptance(amendment, proponentMemberId);
  if (!party || party.decision !== "pending") return null;
  if (actorMemberId !== null && party.member.id === actorMemberId) {
    return amendment.can.accept ? { party, memberId: null } : null;
  }
  return amendment.can.moderate ? { party, memberId: party.member.id } : null;
}

/**
 * The presenter's answers to transactionals on record, from the data (so a
 * reload keeps them): approved or rejected, whoever recorded it. Drafts and
 * the transactionals the presenter proposed itself (its row is accepted on
 * creation) are left out.
 */
export function transactionalAnswerCounts(
  amendments: readonly Pick<
    AmendmentDto,
    "kind" | "status" | "authors" | "acceptances"
  >[],
  proponentMemberId: string | null,
): { approved: number; rejected: number } {
  const counts = { approved: 0, rejected: 0 };
  for (const amendment of amendments) {
    if (amendment.kind !== "transactional" || amendment.status === "draft") {
      continue;
    }
    if (
      proponentMemberId !== null &&
      amendment.authors.some((author) => author.id === proponentMemberId)
    ) {
      continue;
    }
    const decision = proponentAcceptance(
      amendment,
      proponentMemberId,
    )?.decision;
    if (decision === "accepted") counts.approved += 1;
    else if (decision === "rejected") counts.rejected += 1;
  }
  return counts;
}

// Queue -------------------------------------------------------------------------

/**
 * Everything the review goes through, in order: the transactionals waiting
 * for the presenter's approval first, then the amendments to answer, both
 * in text order. `proponentMemberId` is the document's presenter (not the
 * viewer, who may be the Mesa answering for it).
 */
export function proponentReviewItems(
  amendments: readonly AmendmentDto[],
  actorMemberId: string | null,
  proponentMemberId: string | null,
): ProponentReviewItem[] {
  const sorted = sortAmendments([...amendments]);
  const transactionals: ProponentReviewItem[] = sorted
    .filter(
      (amendment) =>
        awaitsProponentApproval(amendment, proponentMemberId) &&
        acceptanceTarget(amendment, actorMemberId, proponentMemberId) !== null,
    )
    .map((amendment) => ({
      id: amendment.id,
      kind: "transactional",
      amendment,
      answered: false,
    }));
  const positions: ProponentReviewItem[] = sorted
    .filter(isPositionReviewable)
    .map((amendment) => ({
      id: amendment.id,
      kind: "position",
      amendment,
      answered: isPositionAnswered(amendment),
    }));
  return [...transactionals, ...positions];
}

export interface ProponentReviewProgress {
  /** Amendments answered (a position given). */
  answered: number;
  /** Amendments to answer, answered or not. */
  total: number;
  /** Transactionals waiting for the presenter's approval. */
  transactionals: number;
}

/** The progress line: "3 de 12 respondidas", plus the transactionals left. */
export function proponentReviewProgress(
  items: readonly ProponentReviewItem[],
): ProponentReviewProgress {
  const positions = items.filter((item) => item.kind === "position");
  return {
    answered: positions.filter((item) => item.answered).length,
    total: positions.length,
    transactionals: items.filter((item) => item.kind === "transactional")
      .length,
  };
}

/** How many amendments got each answer, and how many are still pending. */
export function positionCounts(
  items: readonly ProponentReviewItem[],
): Record<ProponentPosition, number> {
  const counts: Record<ProponentPosition, number> = {
    pending: 0,
    accept: 0,
    reject: 0,
    transact: 0,
  };
  for (const item of items) {
    if (item.kind !== "position") continue;
    counts[positionAnswer(item.amendment) ?? "pending"] += 1;
  }
  return counts;
}

/**
 * The answers on record over every presented amendment, decided or not
 * (for the summary once the document is voted and nothing can change).
 */
export function recordedPositionCounts(
  amendments: readonly Pick<AmendmentDto, "kind" | "status" | "position">[],
): Record<ProponentPosition, number> {
  const counts: Record<ProponentPosition, number> = {
    pending: 0,
    accept: 0,
    reject: 0,
    transact: 0,
  };
  for (const amendment of amendments) {
    if (amendment.kind === "transactional" || amendment.status === "draft") {
      continue;
    }
    const answer = positionAnswer(amendment);
    if (answer) counts[answer] += 1;
  }
  return counts;
}

// Cursor ------------------------------------------------------------------------

/** Still waiting for the actor: an approval, or an amendment not answered. */
export function isItemPending(item: ProponentReviewItem): boolean {
  return item.kind === "transactional" || !item.answered;
}

/**
 * The steps on screen. With `onlyPending`, answered amendments drop out,
 * except the one on screen (`pinnedId`): it stays until the user moves on,
 * so answering it never pulls it away mid-click.
 */
export function reviewSequence(
  items: readonly ProponentReviewItem[],
  options: { onlyPending: boolean; pinnedId: string | null },
): ProponentReviewItem[] {
  if (!options.onlyPending) return [...items];
  return items.filter(
    (item) => isItemPending(item) || item.id === options.pinnedId,
  );
}

/**
 * "Enmienda 5 de 12" or "Transaccional 1 de 2": where the step sits among
 * the steps of its kind in the whole review, so the total matches the
 * progress line ("3 de 12 respondidas") and hiding the answered ones does
 * not turn it into a countdown. Null when the step is not in the review.
 */
export function stepCounter(
  items: readonly ProponentReviewItem[],
  id: string | null,
): { kind: ProponentReviewKind; current: number; total: number } | null {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return null;
  const sameKind = items.filter((candidate) => candidate.kind === item.kind);
  return {
    kind: item.kind,
    current: sameKind.indexOf(item) + 1,
    total: sameKind.length,
  };
}

export function stepIndex(
  sequence: readonly ProponentReviewItem[],
  id: string | null,
): number {
  if (id === null) return -1;
  return sequence.findIndex((item) => item.id === id);
}

/** The step after `id`, or null at the end (or when `id` is not there). */
export function stepAfter(
  sequence: readonly ProponentReviewItem[],
  id: string | null,
): string | null {
  const index = stepIndex(sequence, id);
  if (index < 0) return null;
  return sequence[index + 1]?.id ?? null;
}

/** The step before `id`, or null at the start (or when `id` is not there). */
export function stepBefore(
  sequence: readonly ProponentReviewItem[],
  id: string | null,
): string | null {
  const index = stepIndex(sequence, id);
  if (index <= 0) return null;
  return sequence[index - 1]?.id ?? null;
}

/**
 * Where to go when the step on screen leaves the sequence (decided or
 * answered elsewhere): the step that took its place, or the last one.
 */
export function fallbackStep(
  sequence: readonly ProponentReviewItem[],
  lastIndex: number,
): string | null {
  if (sequence.length === 0) return null;
  const index = Math.min(Math.max(lastIndex, 0), sequence.length - 1);
  return sequence[index]?.id ?? null;
}

/** The first step still waiting for the actor, if any. */
export function firstPendingId(
  items: readonly ProponentReviewItem[],
): string | null {
  return items.find(isItemPending)?.id ?? null;
}

/**
 * Where the review opens: the amendment asked for in the link
 * (`?enmienda=<id>`) when it is in the review, otherwise the first one
 * waiting for an answer. Null when nothing is left (the summary shows).
 */
export function initialStep(
  items: readonly ProponentReviewItem[],
  wantedId: string | null,
): string | null {
  if (wantedId && items.some((item) => item.id === wantedId)) return wantedId;
  return firstPendingId(items);
}

/**
 * Pure helpers behind the document workspace: ordering, overlap grouping,
 * gutter markers, filters and the operations the composer builds. No Nuxt or Vue APIs here, so they are unit-tested on their own
 * (workspace.test.ts).
 *
 * Every export is auto-imported app-wide (`imports.dirs: composables/**`),
 * hence the explicit names.
 */
import {
  AMENDMENT_CLOSED_STATUSES,
  type AcceptedAmendmentRule,
  type AmendmentKind,
  type AmendmentStatus,
} from "~~/shared/constants/domain";
import type {
  AmendmentCapabilities,
  AmendmentDto,
  AmendmentReviewState,
  RelationDto,
} from "~~/shared/types/api";
import type {
  AmendmentInput,
  AmendmentOp,
  Block,
} from "~~/shared/types/content";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { diffPassage } from "~~/shared/utils/content/diff";
import {
  firstTouchedBlockId,
  touchedBlockIds,
  validateOps,
} from "~~/shared/utils/content/ops";
import {
  findOverlaps,
  type OverlapKind,
} from "~~/shared/utils/content/overlaps";

type AmendmentLike = Pick<
  AmendmentDto,
  "id" | "kind" | "status" | "ops" | "positionKey" | "number" | "code"
> &
  Partial<Pick<AmendmentDto, "submittedAt" | "decidedAt">>;

// Status and labels ------------------------------------------------------------

export const AMENDMENT_TOTALITY_KINDS: readonly AmendmentKind[] = [
  "totality_return",
  "totality_alternative",
];

export function isTotalityAmendment(kind: AmendmentKind): boolean {
  return AMENDMENT_TOTALITY_KINDS.includes(kind);
}

/** Drafts and submitted amendments: still to be decided. */
export function isAmendmentOpen(amendment: Pick<AmendmentDto, "status">) {
  return !AMENDMENT_CLOSED_STATUSES.includes(amendment.status);
}

/** "12 · CEUM 4", "T1", or null while it is a draft without a number. */
export function amendmentDisplayLabel(
  amendment: Pick<AmendmentDto, "number" | "code" | "kind">,
): string | null {
  if (amendment.kind === "transactional") return amendment.code ?? null;
  const parts = [
    amendment.number !== null ? String(amendment.number) : null,
    amendment.code,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Short reference for provenance marks: the code ("CEUM 4", "T1") or the number. */
export function amendmentShortLabel(
  amendment: Pick<AmendmentDto, "number" | "code">,
): string | null {
  if (amendment.code) return amendment.code;
  return amendment.number !== null ? String(amendment.number) : null;
}

/**
 * Order of two amendment codes ("CEUM 4", "CEA 12", "T 3"): by acronym, then
 * by the number as a number, so "CEA 2" comes before "CEA 10". The codes of
 * every executive area share the acronym "CEA" and one count per document,
 * so they reach two digits sooner. A missing code sorts first.
 */
export function compareAmendmentCodes(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  return (a ?? "").localeCompare(b ?? "", undefined, { numeric: true });
}

// Review by the Secretaría -------------------------------------------------------

/**
 * Not visible to the whole assembly yet: a draft, or a presented amendment
 * the Secretaría has not published. Amendments without a review state past
 * draft (recorded before validation existed) count as public.
 */
export function isAmendmentPrivate(
  amendment: Pick<AmendmentDto, "status" | "reviewState">,
): boolean {
  if (amendment.status === "draft") return true;
  return (
    amendment.reviewState !== null && amendment.reviewState !== "published"
  );
}

/**
 * What the viewer is told about an amendment's review, as an i18n key under
 * `amendment.review.badges` (and the sentence of amendmentReviewSentenceKey):
 * - `draft`: never sent to the Secretaría;
 * - `correction`: sent back to its authors, who can fix it (the viewer can);
 * - `correction_sent`: sent back, seen by someone who cannot edit it;
 * - `pending_authors`: a transactional a member proposed, waiting for the
 *   main author of each amendment it would replace to accept it before the
 *   Secretaría checks it;
 * - `to_validate` / `pending`: waiting for the Secretaría, for the
 *   Secretaría itself and for everyone else;
 * - `to_publish` / `validated`: validated but private, likewise. A decided
 *   amendment that was never published is `to_publish` for the Secretaría,
 *   which can still make it public;
 * - `published`: visible to everyone.
 */
export type AmendmentReviewKey =
  | "draft"
  | "correction"
  | "correction_sent"
  | "pending_authors"
  | "to_validate"
  | "pending"
  | "to_publish"
  | "validated"
  | "published";

export interface AmendmentReviewView {
  key: AmendmentReviewKey;
  color: "neutral" | "info" | "warning" | "success" | "primary";
  icon: string;
  /** Not visible to the whole assembly yet (see isAmendmentPrivate). */
  private: boolean;
  /** Late, validated, and still waiting for the Mesa to admit it. */
  awaitingAdmission: boolean;
}

export type AmendmentReviewInput = Pick<
  AmendmentDto,
  "status" | "reviewState" | "admission"
> & { can: Pick<AmendmentCapabilities, "edit" | "validate" | "publish"> };

const REVIEW_LOOK: Record<
  AmendmentReviewKey,
  Pick<AmendmentReviewView, "color" | "icon">
> = {
  draft: { color: "neutral", icon: "i-lucide-file-pen" },
  correction: { color: "warning", icon: "i-lucide-message-square-warning" },
  correction_sent: { color: "neutral", icon: "i-lucide-undo-2" },
  pending_authors: { color: "info", icon: "i-lucide-users" },
  to_validate: { color: "warning", icon: "i-lucide-inbox" },
  pending: { color: "info", icon: "i-lucide-hourglass" },
  to_publish: { color: "primary", icon: "i-lucide-eye-off" },
  validated: { color: "info", icon: "i-lucide-eye-off" },
  published: { color: "success", icon: "i-lucide-eye" },
};

function reviewKeyOf(
  amendment: AmendmentReviewInput,
): AmendmentReviewKey | null {
  const { status, reviewState, can } = amendment;
  if (status === "draft") {
    if (reviewState === "correction_requested") {
      return can.edit ? "correction" : "correction_sent";
    }
    return "draft";
  }
  // Decided, withdrawn or inadmissible: the outcome says it all, except to
  // the Secretaría while it can still publish it (validated, never made
  // public). Nobody else is told it will be published: a withdrawn or
  // inadmissible one may well stay private.
  if (status !== "submitted") return can.publish ? "to_publish" : null;
  switch (reviewState) {
    case "pending_authors":
      return "pending_authors";
    case "pending_validation":
      return can.validate ? "to_validate" : "pending";
    case "validated":
      return can.publish ? "to_publish" : "validated";
    case "published":
    case null:
      return "published";
    default:
      return null;
  }
}

/**
 * Where an amendment stands with the Secretaría, worded for the viewer
 * (its author, the Secretaría or anyone else). Null once it is decided.
 */
export function amendmentReviewView(
  amendment: AmendmentReviewInput,
): AmendmentReviewView | null {
  const key = reviewKeyOf(amendment);
  if (!key) return null;
  return {
    key,
    ...REVIEW_LOOK[key],
    private: isAmendmentPrivate(amendment),
    awaitingAdmission:
      amendment.status === "submitted" &&
      amendment.admission === "pending" &&
      (amendment.reviewState === "validated" ||
        amendment.reviewState === "published"),
  };
}

/**
 * The sentence for a review key, as an i18n key. Its presenters read about
 * "you" (who can see it, what they do next); anyone else who sees it before
 * publication (the Mesa) reads about the rest of the assembly.
 */
export function amendmentReviewSentenceKey(
  key: AmendmentReviewKey,
  presenter: boolean,
): string {
  const others = !presenter && (key === "pending" || key === "validated");
  return `amendment.review.states.${others ? `${key}_others` : key}`;
}

/**
 * The viewer presents the amendment: their member is one of its authors, or
 * they can edit it (a draft they created).
 */
export function isAmendmentPresenter(
  amendment: Pick<AmendmentDto, "authors"> & {
    can: Pick<AmendmentCapabilities, "edit">;
  },
  memberId: string | null,
): boolean {
  return amendment.can.edit || isAmendmentAuthor(amendment, memberId);
}

/**
 * The actor's amendments waiting for them: those the Secretaría sent back
 * for correction, then the drafts never sent. Only drafts they can edit.
 */
export function amendmentsAwaitingActor<
  T extends Pick<AmendmentDto, "status" | "reviewState"> & {
    can: Pick<AmendmentCapabilities, "edit">;
  },
>(list: T[]): { corrections: T[]; drafts: T[] } {
  const editable = list.filter(
    (amendment) => amendment.status === "draft" && amendment.can.edit,
  );
  return {
    corrections: editable.filter(
      (amendment) => amendment.reviewState === "correction_requested",
    ),
    drafts: editable.filter(
      (amendment) => amendment.reviewState !== "correction_requested",
    ),
  };
}

type ReturnedInput = Pick<AmendmentDto, "status" | "reviewState"> & {
  can: Pick<AmendmentCapabilities, "edit">;
};

/**
 * Sent back for correction, seen by someone who cannot edit it (the
 * Secretaría): a draft again, waiting for its authors to fix it and send it
 * again. Its authors, who can edit it, find it in "Mis enmiendas" instead.
 * Drafts never sent (reviewers receive those too) do not count.
 */
export function isAmendmentReturnedForCorrection(
  amendment: ReturnedInput,
): boolean {
  return (
    amendment.status === "draft" &&
    amendment.reviewState === "correction_requested" &&
    !amendment.can.edit
  );
}

/** The amendments sent back for correction the viewer cannot edit, in order. */
export function amendmentsReturnedForCorrection<T extends ReturnedInput>(
  list: T[],
): T[] {
  return list.filter(isAmendmentReturnedForCorrection);
}

/**
 * What the Secretaría still has to do on the document's amendments (drafts
 * included): presented ones to validate or publish, and how many it sent
 * back for correction (counted for reviewers only, `can.review`).
 */
export function amendmentReviewQueue(
  list: (Pick<AmendmentDto, "status" | "reviewState"> & {
    can: Pick<
      AmendmentCapabilities,
      "validate" | "publish" | "edit" | "review"
    >;
  })[],
): { toValidate: number; toPublish: number; returned: number } {
  const presented = list.filter((amendment) => amendment.status !== "draft");
  return {
    toValidate: presented.filter((amendment) => amendment.can.validate).length,
    toPublish: presented.filter((amendment) => amendment.can.publish).length,
    returned: list.filter(
      (amendment) =>
        amendment.can.review && isAmendmentReturnedForCorrection(amendment),
    ).length,
  };
}

/**
 * The admission badge only means something once the Secretaría validated
 * the amendment: before that, admission is settled by the validation.
 */
export function showAmendmentAdmission(
  amendment: Pick<AmendmentDto, "status" | "reviewState" | "admission">,
): boolean {
  if (amendment.status === "draft") return false;
  if (
    amendment.reviewState === "pending_authors" ||
    amendment.reviewState === "pending_validation" ||
    amendment.reviewState === "correction_requested"
  ) {
    return false;
  }
  return amendment.admission !== "admitted";
}

/**
 * How lateness reads on an amendment presented after the window closed:
 * - `awaiting_decision`: the Secretaría validated it and it waits for the
 *   assembly to decide whether to treat it ("Pendiente de que la asamblea
 *   decida tratarla"); until then it is neither debated nor decided;
 * - `late`: just "Fuera de plazo" (still with the Secretaría, or already
 *   admitted or decided);
 * - null: on time.
 */
export function amendmentLateState(
  amendment: Pick<
    AmendmentDto,
    "late" | "status" | "reviewState" | "admission"
  >,
): "awaiting_decision" | "late" | null {
  if (!amendment.late) return null;
  return amendment.status === "submitted" &&
    amendment.admission === "pending" &&
    (amendment.reviewState === "validated" ||
      amendment.reviewState === "published")
    ? "awaiting_decision"
    : "late";
}

/**
 * What to tell the author right after sending an amendment: it waits for
 * the Secretaría (`review`, or `review_late` when the Mesa must also admit
 * it), or it is public at once (a transactional presented by the Mesa).
 */
export function amendmentSentNotice(
  amendment: Pick<AmendmentDto, "late" | "reviewState">,
): "review" | "review_late" | "public" {
  if (amendment.reviewState === "published") return "public";
  return amendment.late ? "review_late" : "review";
}

/**
 * Whether sending a draft now makes it late. One the Secretaría sent back
 * for correction keeps the timing of its first presentation (the server's
 * submissionLate); any other is late once the window has closed.
 */
export function amendmentLateOnSend(
  draft: Pick<AmendmentDto, "late" | "reviewState"> | null | undefined,
  windowClosed: boolean,
): boolean {
  return draft?.reviewState === "correction_requested"
    ? draft.late
    : windowClosed;
}

// The main presenter's answer ---------------------------------------------------

type PositionInput = Pick<
  AmendmentDto,
  | "kind"
  | "status"
  | "reviewState"
  | "admission"
  | "validatedAt"
  | "acceptances"
  | "approvalMethod"
>;

/**
 * Why the main presenter cannot answer an undecided amendment yet, by what
 * has to happen first:
 * - `authors`: a transactional the main authors of the amendments it would
 *   replace have not all accepted (only "author" rows count, as on the
 *   server);
 * - `validation`: the Secretaría has to validate it;
 * - `admission`: late, the assembly has to decide whether to treat it;
 * - `publication`: validated, but the Secretaría keeps it private. Only
 *   published amendments are answered, whatever the document's rule:
 *   delegates must be able to read what the presenter answers.
 * Checked in that order: a late one validated and kept private waits for
 * the assembly first.
 */
export type AmendmentPositionBlocker =
  "authors" | "validation" | "admission" | "publication";

/**
 * Anything that settles every answer for good. With `finalVoted` (the
 * document's final vote is on record, `DocumentDto.finalVote`) nothing can
 * be answered any more, not even an amendment the presenter's acceptance
 * incorporated. Optional, so callers that do not know it keep the
 * amendment-level rule.
 */
export interface AmendmentPositionContext {
  finalVoted?: boolean;
}

/**
 * Agrees with the server's positionBlocker (server/utils/domain/reviewState.ts)
 * on whether an amendment can be answered, as decided for the presenter's
 * answers (design.md, "Amendment flow"): only published amendments,
 * validated and, when late, admitted, and nothing after the final vote.
 * The reason given may differ: a transactional its main authors have not
 * all accepted waits for them first (`authors`), because the Secretaría
 * does not check it until they do, while the server reports it as not
 * validated or not admitted. Shared with positionWaitReason in the review
 * mode, so the workspace, the review mode and the home page agree. An
 * amendment recorded before validation existed (no review state) counts as
 * published.
 */
function positionWait(
  amendment: PositionInput,
  rule: AcceptedAmendmentRule,
  context: AmendmentPositionContext = {},
): AmendmentPositionBlocker | "decided" | null {
  if (context.finalVoted) return "decided";
  if (
    rule === "incorporate" &&
    amendment.status === "approved" &&
    amendment.approvalMethod === "proponent"
  ) {
    return null;
  }
  if (amendment.status !== "submitted") return "decided";
  if (
    amendment.kind === "transactional" &&
    amendment.acceptances.some(
      (party) => party.role === "author" && party.decision !== "accepted",
    )
  ) {
    return "authors";
  }
  const state = amendment.reviewState;
  const validated = state === "validated" || state === "published";
  if (!validated && state !== null) return "validation";
  if (amendment.admission !== "admitted") {
    return validated || amendment.validatedAt !== null
      ? "admission"
      : "validation";
  }
  if (state === "validated") return "publication";
  return null;
}

/**
 * The amendment has reached the document's main presenter, who can answer
 * it (design.md, "Amendment flow"): published by the Secretaría (so
 * validated), admitted (a late one once the assembly decided to treat it),
 * and for a transactional, accepted by every main author, so it replaced
 * the amendments it combines. Still undecided, or approved because the
 * presenter accepted it under the "incorporate" rule: the presenter can
 * change that answer until the final vote, and nothing after it
 * (`context.finalVoted`).
 */
export function amendmentAwaitsPosition(
  amendment: PositionInput,
  rule: AcceptedAmendmentRule,
  context: AmendmentPositionContext = {},
): boolean {
  return positionWait(amendment, rule, context) === null;
}

/**
 * Why the main presenter cannot answer yet, for an undecided amendment that
 * has not reached it (AmendmentPositionBlocker). Null when it can be
 * answered, or it is decided (or the document was voted).
 */
export function amendmentPositionBlocker(
  amendment: PositionInput,
  rule: AcceptedAmendmentRule,
  context: AmendmentPositionContext = {},
): AmendmentPositionBlocker | null {
  const wait = positionWait(amendment, rule, context);
  return wait === "decided" ? null : wait;
}

/**
 * Accepting an undecided amendment the Secretaría validated but keeps
 * private, under the "incorporate" rule, would put in the text something
 * delegates cannot read. Such an amendment cannot be answered at all now
 * (the `publication` blocker of amendmentPositionBlocker), so this never
 * decides anything on its own. Its only caller left is sessionPositionMenu
 * (~/composables/session/sessionModel.ts); remove it once that stops using
 * it.
 */
export function amendmentAcceptBlocked(
  amendment: Pick<AmendmentDto, "status" | "reviewState">,
  rule: AcceptedAmendmentRule,
): boolean {
  return (
    rule === "incorporate" &&
    amendment.status === "submitted" &&
    amendment.reviewState === "validated"
  );
}

/**
 * What happens next with the main presenter's answer, by the document's rule
 * for accepted amendments (an i18n key under `amendment.position.next`):
 * - `incorporateIfAccepted`: "incorporate", no answer yet: accepting it puts
 *   it in the text without a vote, otherwise the assembly votes it;
 * - `incorporated`: accepted under "incorporate": it is in the text, and
 *   changing the answer before the final vote reopens it;
 * - `vote`: the assembly votes it (rule "vote", or not accepted);
 * - `voteAnyway`: rule "vote" and no answer yet: voted whatever the answer.
 * Null once it is decided otherwise (voted, withdrawn...), after the final
 * vote, or while it has not reached the presenter (amendmentPositionBlocker
 * says why).
 */
export type AmendmentPositionNext =
  "incorporateIfAccepted" | "incorporated" | "vote" | "voteAnyway";

export function amendmentPositionNext(
  amendment: PositionInput & Pick<AmendmentDto, "position">,
  rule: AcceptedAmendmentRule,
  context: AmendmentPositionContext = {},
): AmendmentPositionNext | null {
  if (!amendmentAwaitsPosition(amendment, rule, context)) return null;
  const answer = amendment.position?.position ?? "pending";
  if (rule === "incorporate") {
    if (answer === "accept") return "incorporated";
    return answer === "pending" ? "incorporateIfAccepted" : "vote";
  }
  return answer === "pending" ? "voteAnyway" : "vote";
}

// Authors ------------------------------------------------------------------------

/**
 * The main author of an amendment: the one named (`mainAuthorId`), or its
 * first author (the only one, or the order the API gives). It answers the
 * transactionals proposed over the amendment.
 */
export function amendmentMainAuthor<T extends { id: string }>(amendment: {
  authors: T[];
  mainAuthorId: string | null;
}): T | null {
  return (
    amendment.authors.find((author) => author.id === amendment.mainAuthorId) ??
    amendment.authors[0] ??
    null
  );
}

/**
 * Authors with the main one first, the rest as the API lists them, and
 * whether to mark the main one (only when there are several).
 */
export function amendmentAuthorsInOrder<T extends { id: string }>(amendment: {
  authors: T[];
  mainAuthorId: string | null;
}): { main: T | null; others: T[]; marked: boolean } {
  const main = amendmentMainAuthor(amendment);
  return {
    main,
    others: amendment.authors.filter((author) => author !== main),
    marked: amendment.authors.length > 1,
  };
}

/** The actor's member presents it (alone or with others). */
export function isAmendmentAuthor(
  amendment: Pick<AmendmentDto, "authors">,
  memberId: string | null,
): boolean {
  return (
    memberId !== null &&
    amendment.authors.some((author) => author.id === memberId)
  );
}

function mineRank(
  amendment: Pick<AmendmentDto, "status" | "reviewState">,
): number {
  if (amendment.status === "draft") {
    return amendment.reviewState === "correction_requested" ? 0 : 1;
  }
  if (amendment.status !== "submitted") return 5;
  if (
    amendment.reviewState === "pending_authors" ||
    amendment.reviewState === "pending_validation"
  ) {
    return 2;
  }
  if (amendment.reviewState === "validated") return 3;
  return 4;
}

/**
 * "Mis enmiendas": the drafts the actor can edit and every amendment their
 * member presents, what needs their attention first (corrections asked,
 * then drafts), then those waiting for the Secretaría, the published ones
 * and the decided ones. Text order is kept within each group.
 */
export function mineAmendments<
  T extends Pick<AmendmentDto, "status" | "reviewState" | "authors"> & {
    can: Pick<AmendmentCapabilities, "edit">;
  },
>(list: T[], memberId: string | null): T[] {
  return list
    .filter(
      (amendment) =>
        (amendment.status === "draft" && amendment.can.edit) ||
        isAmendmentAuthor(amendment, memberId),
    )
    .map((amendment, index) => ({ amendment, index }))
    .sort(
      (a, b) =>
        mineRank(a.amendment) - mineRank(b.amendment) || a.index - b.index,
    )
    .map(({ amendment }) => amendment);
}

function timeOf(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/** Text order: position in the base, then number, then submission time. */
export function compareAmendments(a: AmendmentLike, b: AmendmentLike): number {
  if (a.positionKey !== b.positionKey) return a.positionKey - b.positionKey;
  const na = a.number ?? Number.POSITIVE_INFINITY;
  const nb = b.number ?? Number.POSITIVE_INFINITY;
  if (na !== nb) return na - nb;
  const ta = timeOf(a.submittedAt);
  const tb = timeOf(b.submittedAt);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortAmendments<T extends AmendmentLike>(list: T[]): T[] {
  return [...list].sort(compareAmendments);
}

// Overlaps ---------------------------------------------------------------------

/** Amendments that act on concrete passages (totality ones act on everything). */
function passageAmendments<T extends AmendmentLike>(list: T[]): T[] {
  return list.filter(
    (amendment) =>
      !isTotalityAmendment(amendment.kind) && amendment.ops.length > 0,
  );
}

export interface AmendmentOverlap {
  id: string;
  kind: OverlapKind;
}

type LineageLike = AmendmentLike & Partial<Pick<AmendmentDto, "sourceIds">>;

/**
 * The amendments a transactional combines, and the ones those combine in
 * turn (a transactional built on another absorbs its sources too). Ids not
 * in the list are kept; empty for anything but a transactional.
 */
function lineageOf(
  amendment: LineageLike,
  byId: ReadonlyMap<string, LineageLike>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...(amendment.sourceIds ?? [])];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(byId.get(id)?.sourceIds ?? []));
  }
  return seen;
}

/**
 * For each amendment, the others it overlaps with and how. A transactional
 * and the amendments it combines rewrite the same passage by design: they
 * are not listed as overlapping each other.
 */
export function amendmentOverlapIndex(
  list: LineageLike[],
): Map<string, AmendmentOverlap[]> {
  const index = new Map<string, AmendmentOverlap[]>();
  const byId = new Map(list.map((amendment) => [amendment.id, amendment]));
  const lineage = new Map<string, Set<string>>();
  const lineageFor = (id: string): Set<string> => {
    let ids = lineage.get(id);
    if (!ids) {
      const amendment = byId.get(id);
      ids = amendment ? lineageOf(amendment, byId) : new Set();
      lineage.set(id, ids);
    }
    return ids;
  };
  const { pairs } = findOverlaps(
    passageAmendments(list).map(({ id, ops }) => ({ id, ops })),
  );
  for (const pair of pairs) {
    if (lineageFor(pair.a).has(pair.b) || lineageFor(pair.b).has(pair.a)) {
      continue;
    }
    const a = index.get(pair.a) ?? [];
    a.push({ id: pair.b, kind: pair.kind });
    index.set(pair.a, a);
    const b = index.get(pair.b) ?? [];
    b.push({ id: pair.a, kind: pair.kind });
    index.set(pair.b, b);
  }
  return index;
}

export interface AmendmentGroup<T extends AmendmentLike = AmendmentDto> {
  key: string;
  /**
   * - `totality`: amendments to the whole text, always first (usual practice);
   * - `overlap`: amendments acting on the same passage;
   * - `single`: an amendment that overlaps with none of the others.
   */
  kind: "totality" | "overlap" | "single";
  amendments: T[];
}

/**
 * Groups amendments by overlap cluster, in text order. Groups follow the
 * position of their first member; members keep text order.
 */
export function groupAmendmentsByOverlap<T extends AmendmentLike>(
  list: T[],
): AmendmentGroup<T>[] {
  const sorted = sortAmendments(list);
  const totality = sorted.filter((amendment) =>
    isTotalityAmendment(amendment.kind),
  );
  const rest = sorted.filter(
    (amendment) => !isTotalityAmendment(amendment.kind),
  );
  const { clusters } = findOverlaps(
    passageAmendments(rest).map(({ id, ops }) => ({ id, ops })),
  );
  const clusterOf = new Map<string, number>();
  clusters.forEach((cluster, i) =>
    cluster.forEach((id) => clusterOf.set(id, i)),
  );

  const groups: AmendmentGroup<T>[] = [];
  if (totality.length > 0) {
    groups.push({ key: "totality", kind: "totality", amendments: totality });
  }
  const byCluster = new Map<number, AmendmentGroup<T>>();
  for (const amendment of rest) {
    const cluster = clusterOf.get(amendment.id);
    if (cluster === undefined) {
      groups.push({
        key: amendment.id,
        kind: "single",
        amendments: [amendment],
      });
      continue;
    }
    let group = byCluster.get(cluster);
    if (!group) {
      group = {
        key: `cluster-${amendment.id}`,
        kind: "overlap",
        amendments: [],
      };
      byCluster.set(cluster, group);
      groups.push(group);
    }
    group.amendments.push(amendment);
  }
  return groups;
}

// Gutter markers ---------------------------------------------------------------

/** Same shape as ContentView's BlockMarker. */
export interface AmendmentBlockMarker {
  count: number;
  overlap: boolean;
}

/**
 * How many undecided amendments touch each base block, and whether two of
 * them overlap there. Totality amendments are left out: they touch every
 * block and are listed apart.
 */
export function amendmentBlockMarkers(
  list: AmendmentLike[],
): Record<string, AmendmentBlockMarker> {
  const open = passageAmendments(list.filter(isAmendmentOpen));
  const touched = new Map(
    open.map((amendment) => [
      amendment.id,
      new Set(touchedBlockIds(amendment.ops)),
    ]),
  );
  const markers: Record<string, AmendmentBlockMarker> = {};
  for (const ids of touched.values()) {
    for (const id of ids) {
      const marker = (markers[id] ??= { count: 0, overlap: false });
      marker.count += 1;
    }
  }
  const { pairs } = findOverlaps(open.map(({ id, ops }) => ({ id, ops })));
  for (const pair of pairs) {
    const a = touched.get(pair.a);
    const b = touched.get(pair.b);
    if (!a || !b) continue;
    for (const id of a) {
      if (b.has(id) && markers[id]) markers[id].overlap = true;
    }
  }
  return markers;
}

/**
 * The undecided amendments that act on any of these base blocks, in text
 * order: what someone changing those paragraphs should read first, so they
 * do not propose what is already presented. Totality amendments are left
 * out (they touch every block), and so is `exceptId` (the draft being
 * written).
 */
export function amendmentsOnBlocks<T extends AmendmentLike>(
  list: T[],
  blockIds: Iterable<string>,
  exceptId: string | null = null,
): T[] {
  const wanted = new Set(blockIds);
  if (wanted.size === 0) return [];
  return sortAmendments(
    passageAmendments(list.filter(isAmendmentOpen)).filter(
      (amendment) =>
        amendment.id !== exceptId &&
        touchedBlockIds(amendment.ops).some((id) => wanted.has(id)),
    ),
  );
}

// Filters ----------------------------------------------------------------------

export type AmendmentLateFilter = "any" | "late" | "on_time";

/**
 * Where an amendment stands with the Secretaría. Every value but
 * `correction_requested` narrows the presented amendments; that one shows
 * instead the drafts sent back for correction the viewer cannot edit
 * (isAmendmentReturnedForCorrection), which never mix with the others.
 */
export type AmendmentReviewFilter = "any" | AmendmentReviewState;

export const AMENDMENT_REVIEW_FILTERS: readonly AmendmentReviewFilter[] = [
  "any",
  "pending_authors",
  "pending_validation",
  "correction_requested",
  "validated",
  "published",
];

export interface AmendmentFilters {
  statuses: AmendmentStatus[];
  memberIds: string[];
  kinds: AmendmentKind[];
  late: AmendmentLateFilter;
  /** Where it stands with the Secretaría (reviewers and authors). */
  review: AmendmentReviewFilter;
  /** Only amendments presented by the actor's member. */
  mine: boolean;
  /** Only amendments the account still has to read (its read marks). */
  unread: boolean;
  /** Only amendments touching this base block (gutter marker). */
  blockId: string | null;
  query: string;
}

export function emptyAmendmentFilters(): AmendmentFilters {
  return {
    statuses: [],
    memberIds: [],
    kinds: [],
    late: "any",
    review: "any",
    mine: false,
    unread: false,
    blockId: null,
    query: "",
  };
}

/** Number of filters in use, for the filter button badge. */
export function activeAmendmentFilterCount(filters: AmendmentFilters): number {
  return (
    (filters.statuses.length > 0 ? 1 : 0) +
    (filters.memberIds.length > 0 ? 1 : 0) +
    (filters.kinds.length > 0 ? 1 : 0) +
    (filters.late !== "any" ? 1 : 0) +
    (filters.review !== "any" ? 1 : 0) +
    (filters.mine ? 1 : 0) +
    (filters.unread ? 1 : 0) +
    (filters.blockId ? 1 : 0) +
    (filters.query.trim() ? 1 : 0)
  );
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * The amendments that pass every filter. The `correction_requested` review
 * filter keeps only the drafts sent back that the viewer cannot edit
 * (isAmendmentReturnedForCorrection); every other value leaves drafts out.
 * `isUnread` says which ones the account still has to read, for the
 * `unread` filter; without it that filter lists nothing.
 */
export function filterAmendmentList(
  list: AmendmentDto[],
  filters: AmendmentFilters,
  actorMemberId: string | null,
  isUnread: (id: string) => boolean = () => false,
): AmendmentDto[] {
  const query = fold(filters.query.trim());
  const returnedOnly = filters.review === "correction_requested";
  return list.filter((amendment) => {
    if (
      returnedOnly
        ? !isAmendmentReturnedForCorrection(amendment)
        : amendment.status === "draft"
    ) {
      return false;
    }
    if (
      filters.statuses.length > 0 &&
      !filters.statuses.includes(amendment.status)
    ) {
      return false;
    }
    if (filters.kinds.length > 0 && !filters.kinds.includes(amendment.kind)) {
      return false;
    }
    if (
      filters.memberIds.length > 0 &&
      !amendment.authors.some((author) => filters.memberIds.includes(author.id))
    ) {
      return false;
    }
    if (filters.late === "late" && !amendment.late) return false;
    if (filters.late === "on_time" && amendment.late) return false;
    // Amendments recorded before validation existed have no state: public.
    if (
      filters.review !== "any" &&
      (amendment.reviewState ?? "published") !== filters.review
    ) {
      return false;
    }
    if (
      filters.mine &&
      !(
        actorMemberId &&
        amendment.authors.some((author) => author.id === actorMemberId)
      )
    ) {
      return false;
    }
    if (filters.unread && !isUnread(amendment.id)) return false;
    if (
      filters.blockId &&
      !touchedBlockIds(amendment.ops).includes(filters.blockId)
    ) {
      return false;
    }
    if (query) {
      const haystack = fold(
        [
          amendmentDisplayLabel(amendment) ?? "",
          amendment.justification,
          ...amendment.authors.flatMap((author) => [
            author.acronym,
            author.name,
          ]),
        ].join(" "),
      );
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

// Reader -----------------------------------------------------------------------

/**
 * The filters offered as visible chips over the list: everything, only the
 * undecided ones, only the ones the account still has to read, only the
 * late ones. ("Mías" is the list of the actor's own amendments, a tab of
 * its own, not a filter.)
 */
export type AmendmentQuickFilter = "all" | "pending" | "unread" | "late";

export const AMENDMENT_QUICK_FILTERS: readonly AmendmentQuickFilter[] = [
  "all",
  "pending",
  "unread",
  "late",
];

/**
 * The chip the filters amount to, or null when they are a combination no
 * chip stands for:
 * - `all`: nothing filtered (a search apart);
 * - `pending`: only the presented, undecided ones, on time or late;
 * - `unread`: only the ones left to read, whatever their status or timing;
 * - `late`: only the late ones, whatever their status.
 * Filters with no chip (kind, member, review, paragraph) may narrow
 * `pending`, `unread` and `late` further; `all` means none is set.
 */
export function amendmentQuickFilterOf(
  filters: AmendmentFilters,
): AmendmentQuickFilter | null {
  if (activeAmendmentFilterCount({ ...filters, query: "" }) === 0) return "all";
  if (filters.mine) return null;
  if (filters.unread) {
    return filters.statuses.length === 0 && filters.late === "any"
      ? "unread"
      : null;
  }
  if (
    filters.statuses.length === 1 &&
    filters.statuses[0] === "submitted" &&
    filters.late === "any"
  ) {
    return "pending";
  }
  if (filters.late === "late" && filters.statuses.length === 0) return "late";
  return null;
}

/**
 * The filters after pressing a chip. `all` clears every filter but the
 * search; the others set the status, the timing and whether only what is
 * left to read shows, and keep the rest. `pending` and `unread` leave the
 * drafts sent back for correction, which are neither presented nor
 * published.
 */
export function applyAmendmentQuickFilter(
  filters: AmendmentFilters,
  quick: AmendmentQuickFilter,
): AmendmentFilters {
  if (quick === "all") {
    return { ...emptyAmendmentFilters(), query: filters.query };
  }
  const review =
    filters.review === "correction_requested" ? "any" : filters.review;
  if (quick === "pending") {
    return {
      ...filters,
      statuses: ["submitted"],
      late: "any",
      mine: false,
      unread: false,
      review,
    };
  }
  if (quick === "unread") {
    return {
      ...filters,
      statuses: [],
      late: "any",
      mine: false,
      unread: true,
      review,
    };
  }
  return {
    ...filters,
    statuses: [],
    late: "late",
    mine: false,
    unread: false,
  };
}

/** Where an amendment sits in the list on screen, and what is next to it. */
export interface AmendmentNeighbours {
  /** Zero-based position, or -1 when the list does not hold it. */
  index: number;
  total: number;
  previous: string | null;
  next: string | null;
}

/**
 * The amendments before and after one in the list as shown (filtered, in
 * its order), for reading them one after another. An amendment the list
 * does not hold (opened from the text or a link, or filtered out since) has
 * no neighbours.
 */
export function amendmentNeighbours(
  ids: readonly string[],
  id: string | null,
): AmendmentNeighbours {
  const index = id === null ? -1 : ids.indexOf(id);
  if (index < 0) {
    return { index: -1, total: ids.length, previous: null, next: null };
  }
  return {
    index,
    total: ids.length,
    previous: ids[index - 1] ?? null,
    next: ids[index + 1] ?? null,
  };
}

/**
 * The one status an amendment shows in a card or at the top of its detail:
 * where it stands with the Secretaría while it is a draft or waits for it
 * ("Sin enviar", "En revisión"), which says more than "Borrador" or
 * "Presentada"; otherwise its status (presented, or how it ended). A
 * published amendment only says so where asked (`showPublished`); the
 * lists never ask: being public is the usual case.
 */
export type AmendmentStatusLine =
  | { type: "review"; view: AmendmentReviewView }
  | { type: "status"; status: AmendmentStatus };

export function amendmentStatusLine(
  amendment: AmendmentReviewInput,
  options: { showPublished?: boolean } = {},
): AmendmentStatusLine {
  const view =
    amendment.status === "draft" || amendment.status === "submitted"
      ? amendmentReviewView(amendment)
      : null;
  if (view && (options.showPublished || view.key !== "published")) {
    return { type: "review", view };
  }
  return { type: "status", status: amendment.status };
}

// Relations --------------------------------------------------------------------

export interface AmendmentRelationView {
  relation: RelationDto;
  otherId: string;
  /** "from": this amendment is the subject ("depende de X"). */
  direction: "from" | "to";
}

export function amendmentRelationsOf(
  id: string,
  relations: RelationDto[],
): AmendmentRelationView[] {
  return relations.flatMap((relation): AmendmentRelationView[] => {
    if (relation.fromId === id) {
      return [{ relation, otherId: relation.toId, direction: "from" }];
    }
    if (relation.toId === id) {
      return [{ relation, otherId: relation.fromId, direction: "to" }];
    }
    return [];
  });
}

// Composer operations ------------------------------------------------------------

function cloneBlock(block: Block): Block {
  return {
    ...block,
    marks: block.marks.map((mark) => ({ ...mark })),
  };
}

/**
 * What the composer's editor opens with: the whole base text, or that text
 * as a stored draft leaves it (its operations applied), so the author goes
 * on editing where they stopped. A draft that no longer applies starts again
 * from the base.
 */
export function composerDocumentSeed(
  base: Block[],
  ops: AmendmentOp[] = [],
): Block[] {
  if (ops.length > 0 && validateOps(base, ops).length === 0) {
    const result = consolidate(base, [{ id: "draft", ops }]);
    if (result.conflicts.length === 0) return result.blocks.map(cloneBlock);
  }
  return base.map(cloneBlock);
}

/**
 * Where a draft's editor opens: at its first change in the order of the
 * text. `shown` is what the editor holds (composerDocumentSeed); a block the
 * draft removes is not there, so the nearest block that is stands in for it,
 * the one before it first.
 */
export function composerStartBlockId(
  base: Block[],
  ops: AmendmentOp[],
  shown: Block[],
): string | null {
  const first = firstTouchedBlockId(ops, base);
  if (first === null) return null;
  const present = new Set(shown.map((block) => block.id));
  const at = base.findIndex((block) => block.id === first);
  if (at < 0) return present.has(first) ? first : null;
  for (let i = at; i >= 0; i -= 1) {
    if (present.has(base[i]!.id)) return base[i]!.id;
  }
  for (let i = at + 1; i < base.length; i += 1) {
    if (present.has(base[i]!.id)) return base[i]!.id;
  }
  return null;
}

/**
 * Tells what the author really touched. An editor may give a block back a
 * little different from how it was stored (spacing, the order of its marks)
 * without anyone editing it. `echo` is the seed as the editor returns it
 * untouched: a block that still equals its echo is taken as the seed's own,
 * so it never shows up as a change.
 */
export function composerEditSettler(
  seed: Block[],
  echo: Block[],
): (edited: Block[]) => Block[] {
  const seedById = new Map(seed.map((block) => [block.id, block]));
  const echoById = new Map<string, string>();
  for (const block of echo) {
    if (seedById.has(block.id)) echoById.set(block.id, JSON.stringify(block));
  }
  return (edited) =>
    edited.map((block) => {
      const untouched = echoById.get(block.id);
      return untouched !== undefined && untouched === JSON.stringify(block)
        ? seedById.get(block.id)!
        : block;
    });
}

/**
 * Operations turning the whole base text into what the author left in the
 * editor: changed text and formatting, new blocks and removed ones. Nobody
 * says whether it modifies, adds or suppresses: the difference does.
 */
export function documentAmendmentOps(
  base: Block[],
  edited: Block[],
  newId: () => string,
): AmendmentOp[] {
  return diffPassage(base, edited, null, newId);
}

/**
 * How many paragraphs an amendment changes ("Has cambiado N párrafos"):
 * the base blocks it rewrites, formats or removes, plus the ones it adds.
 */
export function changedBlockCount(ops: AmendmentOp[]): number {
  const touched = new Set<string>();
  let added = 0;
  for (const op of ops) {
    if (op.op === "replace") touched.add(op.blockId);
    else if (op.op === "delete") op.blockIds.forEach((id) => touched.add(id));
    else added += op.blocks.length;
  }
  return touched.size + added;
}

/**
 * "Texto alternativo": deletes the whole base and inserts the new text at the
 * start. Empty blocks are dropped and ids already used by the base are renewed.
 */
export function totalityAlternativeOps(
  base: Block[],
  blocks: Block[],
  newId: () => string,
): AmendmentOp[] {
  const taken = new Set(base.map((block) => block.id));
  const fresh = blocks
    // An image has no text and still counts.
    .filter((block) => block.text.trim() !== "" || block.type === "image")
    .map((block) => {
      let id = block.id;
      while (taken.has(id)) id = newId();
      taken.add(id);
      return id === block.id ? block : { ...block, id };
    });
  const ops: AmendmentOp[] = [];
  if (base.length > 0) {
    ops.push({ op: "delete", blockIds: base.map((block) => block.id) });
  }
  if (fresh.length > 0) {
    ops.push({ op: "insert", afterBlockId: null, blocks: fresh });
  }
  return ops;
}

/** The blocks a "texto alternativo" inserts. */
export function insertedBlocksOf(ops: AmendmentOp[]): Block[] {
  return ops.flatMap((op) => (op.op === "insert" ? op.blocks : []));
}

// Composer seed ------------------------------------------------------------------

/**
 * What the composer writes:
 * - `document`: the whole text in an editor; everything changed there is one
 *   amendment;
 * - `global`: one word or expression changed everywhere;
 * - `return` and `alternative`: totality amendments.
 */
export type AmendmentComposerMode =
  "document" | "global" | "return" | "alternative";

export const AMENDMENT_TOTALITY_MODES: readonly AmendmentComposerMode[] = [
  "return",
  "alternative",
];

export interface AmendmentComposerSeed {
  mode: AmendmentComposerMode;
  /** Editor content (document and alternative modes). */
  edited: Block[];
  find: string;
  replace: string;
}

/** Composer state to keep editing an existing draft. */
export function seedComposerFromDraft(
  base: Block[],
  draft: Pick<AmendmentDto, "kind" | "ops" | "globalReplace">,
): AmendmentComposerSeed {
  const empty = { edited: [], find: "", replace: "" };
  if (draft.kind === "totality_return") return { ...empty, mode: "return" };
  if (draft.kind === "totality_alternative") {
    return {
      ...empty,
      mode: "alternative",
      edited: insertedBlocksOf(draft.ops).map(cloneBlock),
    };
  }
  if (draft.globalReplace) {
    return {
      ...empty,
      mode: "global",
      find: draft.globalReplace.find,
      replace: draft.globalReplace.replace,
    };
  }
  return {
    ...empty,
    mode: "document",
    edited: composerDocumentSeed(base, draft.ops),
  };
}

// Composer checks ----------------------------------------------------------------

/**
 * What the author still has to do before the amendment can be saved, in the
 * order it is said:
 * - `no_changes`: the text is as it was;
 * - `find_empty`, `same_term`, `no_matches`: the word to change everywhere;
 * - `alternative_empty`: no alternative text yet;
 * - `kind_missing`: content or form was not chosen (never asked of a
 *   totality amendment).
 */
export type ComposerIssue =
  | "no_changes"
  | "find_empty"
  | "same_term"
  | "no_matches"
  | "alternative_empty"
  | "kind_missing";

export function composerIssues(input: {
  mode: AmendmentComposerMode;
  /** Content ("partial") or form ("formal"); null until the author chooses. */
  kind: "partial" | "formal" | null;
  ops: AmendmentOp[];
  find?: string;
  replacement?: string;
  alternative?: Block[];
}): ComposerIssue[] {
  const issues: ComposerIssue[] = [];
  const find = (input.find ?? "").trim();
  switch (input.mode) {
    case "document":
      if (input.ops.length === 0) issues.push("no_changes");
      break;
    case "global":
      if (!find) issues.push("find_empty");
      else if (find === (input.replacement ?? "")) issues.push("same_term");
      else if (input.ops.length === 0) issues.push("no_matches");
      break;
    case "alternative":
      if (
        !(input.alternative ?? []).some(
          (block) => block.text.trim() !== "" || block.type === "image",
        )
      ) {
        issues.push("alternative_empty");
      }
      break;
    default:
      break;
  }
  const asksKind = input.mode === "document" || input.mode === "global";
  if (asksKind && input.kind === null) issues.push("kind_missing");
  return issues;
}

/** The kind to send: the totality kinds follow the mode. */
export function composerAmendmentKind(
  mode: AmendmentComposerMode,
  kind: "partial" | "formal" | null,
): Exclude<AmendmentKind, "transactional"> | null {
  if (mode === "return") return "totality_return";
  if (mode === "alternative") return "totality_alternative";
  return kind;
}

// Composer authors ---------------------------------------------------------------

export interface ComposerAuthorSeed {
  /**
   * Member a new amendment is presented on behalf of (moderators only).
   * Never seeded from a stored draft: the server keeps its presenting member
   * unless the moderator picks another one.
   */
  onBehalfOfMemberId: string | undefined;
  /**
   * Authors shown in the picker: every stored author but the actor's own
   * member (always kept, see `keptMemberId`). The API lists the main author
   * first, so the presenting member cannot be told apart: it stays in the
   * picker, and the server keeps it on every save anyway.
   */
  coAuthorIds: string[];
  /**
   * The actor's member when it is one of the authors. The picker hides it,
   * so it is sent back on every save and the actor never drops out of a
   * draft they are editing.
   */
  keptMemberId: string | null;
  /** The stored main author, when it is still one of the authors. */
  mainAuthorId: string | null;
}

/**
 * Splits a draft's authors into what the composer shows. Nothing is seeded
 * for a new amendment.
 */
export function composerAuthorSeed(
  authorIds: string[],
  ownMemberId: string | null,
  mainAuthorId: string | null = null,
): ComposerAuthorSeed {
  const ownIsAuthor = ownMemberId !== null && authorIds.includes(ownMemberId);
  return {
    onBehalfOfMemberId: undefined,
    coAuthorIds: authorIds.filter((id) => id !== ownMemberId),
    keptMemberId: ownIsAuthor ? ownMemberId : null,
    mainAuthorId:
      mainAuthorId !== null && authorIds.includes(mainAuthorId)
        ? mainAuthorId
        : null,
  };
}

/** `authorMemberIds` to send: the picked co-authors plus the kept own member. */
export function composerAuthorMemberIds(
  coAuthorIds: string[],
  keptMemberId: string | null,
): string[] {
  return keptMemberId && !coAuthorIds.includes(keptMemberId)
    ? [...coAuthorIds, keptMemberId]
    : [...coAuthorIds];
}

/**
 * Every member the amendment will be presented by, as the composer has it:
 * the presenting member of a new amendment (the one picked on behalf, or the
 * actor's own), the kept own member of a stored draft, then the co-authors.
 * The choice of main author is made among these.
 */
export function composerAuthorSet(input: {
  presentingMemberId: string | null | undefined;
  keptMemberId: string | null;
  coAuthorIds: string[];
}): string[] {
  const ids = [
    input.presentingMemberId ?? null,
    input.keptMemberId,
    ...input.coAuthorIds,
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

/**
 * The main author to send (`mainAuthorMemberId`): a choice is required when
 * the amendment has several authors (one that left the set, because its
 * member was removed, no longer counts); with one, it is that one. Sending
 * the sole author matters on a stored draft whose former main author was
 * removed: without it the server would anchor on the stored main author and
 * add it back.
 */
export function composerMainAuthor(
  authorIds: string[],
  chosen: string | null | undefined,
): { required: boolean; value: string | null; missing: boolean } {
  const required = authorIds.length > 1;
  const value = required
    ? chosen && authorIds.includes(chosen)
      ? chosen
      : null
    : (authorIds[0] ?? null);
  return { required, value, missing: required && value === null };
}

// Composer sync ------------------------------------------------------------------

/**
 * True when `remote` is strictly later than `local` (ISO dates). A refresh
 * that started before the composer's own save may land after it with the
 * older copy; that one is not newer and must not look like a conflict.
 */
export function isNewerAmendmentVersion(
  remote: string | null | undefined,
  local: string | null | undefined,
): boolean {
  if (!remote || !local) return false;
  const r = Date.parse(remote);
  const l = Date.parse(local);
  if (Number.isNaN(r) || Number.isNaN(l)) return false;
  return r > l;
}

/**
 * Where the draft being edited stands against the stored one:
 * - `in_sync`: saving uses the composer's own lock token;
 * - `remote_newer`: someone else saved it: load theirs or overwrite;
 * - `conflict`: a save was refused and the stored copy has not arrived yet;
 * - `not_editable`: it was submitted, withdrawn or deleted meanwhile, or the
 *   document stopped admitting amendments (final vote, unpublished).
 */
export type ComposerSyncState =
  "in_sync" | "remote_newer" | "conflict" | "not_editable";

export function composerSyncState(input: {
  draftId: string | null;
  /** The composer's optimistic-lock token (updatedAt of its last load or save). */
  token: string | null;
  /** The stored draft, as the live list has it. */
  remote: Pick<AmendmentDto, "id" | "status" | "updatedAt"> | null;
  /** A save was refused with 409 or 404. */
  conflicted: boolean;
  /** The document still admits amendments (published, amendable, not voted). */
  documentOpen?: boolean;
}): ComposerSyncState {
  const { draftId, token, remote, conflicted, documentOpen = true } = input;
  if (!draftId) return "in_sync";
  if (!documentOpen) return "not_editable";
  const current = remote && remote.id === draftId ? remote : null;
  const newer =
    current !== null && isNewerAmendmentVersion(current.updatedAt, token);
  // Only drafts are edited: a stored copy past that stage ends the edit.
  if (current ? current.status !== "draft" : conflicted) return "not_editable";
  if (newer) return "remote_newer";
  return conflicted ? "conflict" : "in_sync";
}

// History ------------------------------------------------------------------------

/**
 * Changes whenever something that writes to the amendment's history changes.
 * Positions, acceptances and relations live in their own tables and do not
 * touch updatedAt (the optimistic-lock token), so they are folded in here.
 */
export function amendmentHistoryVersion(
  amendment: Pick<AmendmentDto, "updatedAt" | "position" | "acceptances">,
  relationIds: string[],
): string {
  return [
    amendment.updatedAt,
    amendment.position
      ? `${amendment.position.position}@${amendment.position.updatedAt}`
      : "",
    amendment.acceptances
      .map(
        (acceptance) =>
          `${acceptance.member.id}:${acceptance.decision}@${acceptance.decidedAt ?? ""}`,
      )
      .sort()
      .join(","),
    [...relationIds].sort().join(","),
  ].join("|");
}

// Consolidation ------------------------------------------------------------------

/**
 * Amendments to consolidate, in application order: the approved ones by
 * decision time, then (optionally) the undecided ones the proponent accepted.
 */
export function consolidationInputs(
  list: (AmendmentLike & Pick<AmendmentDto, "position">)[],
  includeAccepted = false,
): AmendmentInput[] {
  const approved = list
    .filter((amendment) => amendment.status === "approved")
    .filter((amendment) => amendment.ops.length > 0)
    .sort((a, b) => {
      const ta = timeOf(a.decidedAt);
      const tb = timeOf(b.decidedAt);
      return ta !== tb ? ta - tb : compareAmendments(a, b);
    });
  const accepted = includeAccepted
    ? sortAmendments(
        list.filter(
          (amendment) =>
            amendment.status === "submitted" &&
            amendment.position?.position === "accept" &&
            amendment.ops.length > 0,
        ),
      )
    : [];
  return [...approved, ...accepted].map(({ id, ops }) => ({ id, ops }));
}

// API errors -------------------------------------------------------------------

/** Reason codes of 422 answers (validateOps and the amendment API). */
export const AMENDMENT_ERROR_REASONS = [
  "empty",
  "delete_empty",
  "unknown_block",
  "duplicate_delete",
  "unknown_anchor",
  "duplicate_anchor",
  "insert_empty",
  "duplicate_block_id",
  "out_of_range",
  "anchor_mismatch",
  "noop",
  "replace_in_deleted_block",
  "overlapping_ops",
  "totality_return_ops",
  "inconsistent_counts",
  "format_shape",
  "format_image",
  "duplicate_format",
  "marks_out_of_range",
] as const;

/** i18n key of a reason code; unknown codes share a generic message. */
export function amendmentErrorKey(reason: string): string {
  return (AMENDMENT_ERROR_REASONS as readonly string[]).includes(reason)
    ? `amendment.errors.${reason}`
    : "amendment.errors.unknown";
}

/** Distinct reason codes carried by a 422 response (`data.data.reasons`). */
export function amendmentErrorReasons(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const body = (error as { data?: unknown }).data;
  const inner =
    body && typeof body === "object"
      ? (body as { data?: unknown }).data
      : undefined;
  const reasons =
    inner && typeof inner === "object"
      ? (inner as { reasons?: unknown }).reasons
      : undefined;
  if (!Array.isArray(reasons)) return [];
  const codes = reasons
    .map((item) =>
      item && typeof item === "object"
        ? (item as { reason?: unknown }).reason
        : undefined,
    )
    .filter((code): code is string => typeof code === "string");
  return [...new Set(codes)];
}

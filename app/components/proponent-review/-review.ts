/**
 * Pure helpers behind the main presenter's review mode
 * (/asambleas/<slug>/documentos/<doc>/revisar): which amendments wait for an
 * answer, the order they are shown in, the progress line, the cursor that
 * moves through them and the body each answer sends. No Nuxt or Vue APIs
 * here, so they are unit-tested on their own (-review.test.ts).
 *
 * Only the document's main presenter (or the Mesa for it) answers, and
 * only published amendments: validated by the Secretaría, made visible to
 * everyone and, when late, admitted by the assembly. A transactional is
 * answered like any amendment once its main authors accepted it and the
 * Secretaría published it: approving it before that is their job, not the
 * presenter's. Nothing is answered once the document is voted (the page
 * shows the answers on record instead).
 *
 * Which amendments can be answered follows the server's rule
 * (positionBlocker and countPositionsPending in
 * server/utils/domain/reviewState.ts) through one implementation, the
 * workspace's (amendmentAwaitsPosition and amendmentPositionBlocker in
 * ~/composables/amendment/workspace), read here as positionWaitReason, so
 * the review, its waiting lines, its conflict notices, the document page's
 * backlog (proponentReviewBacklog) and the home page's count never
 * disagree. The final vote is the page's to know (`PositionContext`).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */
import type {
  AcceptedAmendmentRule,
  ProponentPosition,
} from "~~/shared/constants/domain";
import type { AmendmentDto, PositionBody } from "~~/shared/types/api";
import {
  amendmentAwaitsPosition,
  amendmentPositionBlocker,
  sortAmendments,
  type AmendmentPositionContext,
} from "~/composables/amendment/workspace";

/** The answers the main presenter can give to an amendment. */
export type ProponentAnswer = Exclude<ProponentPosition, "pending">;

export const PROPONENT_ANSWERS: readonly ProponentAnswer[] = [
  "accept",
  "reject",
  "transact",
];

export interface ProponentReviewItem {
  id: string;
  amendment: AmendmentDto;
  /** The main presenter already answered (a position other than pending). */
  answered: boolean;
}

type AnswerableInput = Pick<
  AmendmentDto,
  | "status"
  | "kind"
  | "reviewState"
  | "admission"
  | "validatedAt"
  | "approvalMethod"
  | "acceptances"
>;

/**
 * What the review knows about the document beyond each amendment: with
 * `finalVoted` (its final vote is on record, `DocumentDto.finalVote`)
 * nothing can be answered any more, not even an amendment the presenter's
 * acceptance incorporated. The workspace's own context, so the rule has one
 * implementation.
 */
export type PositionContext = AmendmentPositionContext;

// Positions --------------------------------------------------------------------

/** The main presenter has given a position (a null position counts as pending). */
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
 * Accepted by the main presenter and put in the text without a vote (the
 * document's rule is "incorporate"). For display only: whether its answer
 * can still change depends on the rule (positionWaitReason).
 */
export function isIncorporated(
  amendment: Pick<AmendmentDto, "status" | "approvalMethod">,
): boolean {
  return (
    amendment.status === "approved" && amendment.approvalMethod === "proponent"
  );
}

/** Where the main presenter's answer leaves the amendment, for lists. */
export type AnswerStatus = ProponentAnswer | "pending" | "incorporated";

export function answerStatus(
  amendment: Pick<AmendmentDto, "position" | "status" | "approvalMethod">,
): AnswerStatus {
  if (isIncorporated(amendment)) return "incorporated";
  return positionAnswer(amendment) ?? "pending";
}

/** Icon and color of each answer status in the lists. */
export const ANSWER_STATUS_ICONS: Record<
  AnswerStatus,
  { name: string; color: string }
> = {
  pending: { name: "i-lucide-circle-dashed", color: "text-dimmed" },
  accept: { name: "i-lucide-check", color: "text-success" },
  incorporated: { name: "i-lucide-check-check", color: "text-success" },
  reject: { name: "i-lucide-x", color: "text-error" },
  transact: { name: "i-lucide-handshake", color: "text-info" },
};

/**
 * Why the main presenter (or the Mesa for it) cannot answer an amendment
 * here now, or null when it can: the workspace's rule
 * (amendmentAwaitsPosition and amendmentPositionBlocker), which mirrors the
 * server's positionBlocker:
 * - `decided`: no longer undecided, or the document's final vote is on
 *   record (`context.finalVoted`). One the presenter's acceptance
 *   incorporated stays answerable under the "incorporate" rule until that
 *   final vote: changing the answer reopens it;
 * - `authors`: a transactional its main authors have not all accepted yet
 *   (only their answers count);
 * - `validation`: still with the Secretaría;
 * - `admission`: late, and the assembly has not decided to treat it yet;
 * - `publication`: validated but kept private: only the Mesa and the
 *   Secretaría see it, so the presenter answers it once the Secretaría
 *   publishes it, whatever the document's rule.
 */
export type PositionWaitReason =
  "decided" | "authors" | "validation" | "admission" | "publication";

export function positionWaitReason(
  amendment: AnswerableInput,
  rule: AcceptedAmendmentRule,
  context: PositionContext = {},
): PositionWaitReason | null {
  if (amendmentAwaitsPosition(amendment, rule, context)) return null;
  return amendmentPositionBlocker(amendment, rule, context) ?? "decided";
}

/** An amendment whose answer belongs to the main presenter right now, whoever looks. */
export function isPositionAnswerable(
  amendment: AnswerableInput,
  rule: AcceptedAmendmentRule,
  context: PositionContext = {},
): boolean {
  return positionWaitReason(amendment, rule, context) === null;
}

/** An amendment the actor (the main presenter or the Mesa) answers here. */
export function isPositionReviewable(
  amendment: AnswerableInput & {
    can: Pick<AmendmentDto["can"], "position">;
  },
  rule: AcceptedAmendmentRule,
  context: PositionContext = {},
): boolean {
  return (
    amendment.can.position && isPositionAnswerable(amendment, rule, context)
  );
}

/** Amendments still on their way to the main presenter, by what they wait for. */
export type PositionWaitCounts = Record<
  Exclude<PositionWaitReason, "decided">,
  number
>;

/**
 * How many undecided amendments, among those the viewer sees, wait for
 * something before the main presenter can answer them: the lines under the
 * progress ("2 enmiendas fuera de plazo esperan a que la asamblea decida si
 * las trata"). None once the document is voted: nothing is on its way any
 * more.
 */
export function positionWaitCounts(
  amendments: readonly AnswerableInput[],
  rule: AcceptedAmendmentRule,
  context: PositionContext = {},
): PositionWaitCounts {
  const counts: PositionWaitCounts = {
    authors: 0,
    validation: 0,
    admission: 0,
    publication: 0,
  };
  for (const amendment of amendments) {
    const reason = positionWaitReason(amendment, rule, context);
    if (reason && reason !== "decided") counts[reason] += 1;
  }
  return counts;
}

/**
 * Why the review has nothing to answer, for the sentence under its empty
 * state:
 * - `waiting`: amendments are on their way (positionWaitCounts lists them);
 * - `allDecided`: every presented amendment the viewer sees is decided
 *   (drafts do not count: nobody presented them);
 * - `none`: nothing presented yet.
 */
export type EmptyReviewReason = "waiting" | "allDecided" | "none";

export function emptyReviewReason(
  amendments: readonly AnswerableInput[],
  rule: AcceptedAmendmentRule,
): EmptyReviewReason {
  const counts = positionWaitCounts(amendments, rule);
  if (Object.values(counts).some((count) => count > 0)) return "waiting";
  return amendments.some((amendment) => amendment.status !== "draft")
    ? "allDecided"
    : "none";
}

/**
 * How a decided amendment ended, for a co-presenter reading the answers.
 * Null while it is undecided, and for one the presenter's acceptance
 * incorporated (its answer already says so).
 */
export type AmendmentOutcome =
  "approved" | "approvedFormal" | "rejected" | "withdrawn" | "lapsed";

export function amendmentOutcome(
  amendment: Pick<AmendmentDto, "status" | "approvalMethod">,
): AmendmentOutcome | null {
  switch (amendment.status) {
    case "approved":
      if (amendment.approvalMethod === "proponent") return null;
      return amendment.approvalMethod === "formal"
        ? "approvedFormal"
        : "approved";
    case "rejected":
    case "withdrawn":
    case "lapsed":
      return amendment.status;
    default:
      return null;
  }
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

// Saving -------------------------------------------------------------------------

/** The position as the client last saw it: the optimistic-lock token. */
export function seenPositionAt(
  amendment: Pick<AmendmentDto, "position">,
): string | null {
  return amendment.position?.updatedAt || null;
}

/**
 * The body of PUT .../position: the answer, the comment (trimmed, null when
 * empty) and the position the client saw, so two people answering at once
 * get a 409 instead of overwriting each other.
 */
export function positionBody(
  answer: ProponentAnswer,
  comment: string,
  amendment: Pick<AmendmentDto, "position">,
): Required<PositionBody> {
  return {
    position: answer,
    comment: comment.trim() || null,
    positionUpdatedAt: seenPositionAt(amendment),
  };
}

/**
 * Why an answer was refused with 409, once the list is fresh again, so the
 * notice says what happens next in the user's language (the server's own
 * message is never shown: see useApi's notifyError):
 * - `voted`: the document's final vote was recorded meanwhile, so no
 *   answer changes any more (`context.finalVoted`);
 * - `answered`: still in the review, and someone else answered it meanwhile;
 * - `changed`: still in the review with the same answer, or out of it with
 *   nothing to wait for (the document was closed meanwhile);
 * - `gone`: decided meanwhile (voted, withdrawn, replaced by a
 *   transactional), or no longer listed;
 * - a wait reason: it now waits for its main authors, the Secretaría or the
 *   assembly before it can be answered.
 */
export type PositionConflict =
  | "voted"
  | "answered"
  | "changed"
  | "gone"
  | Exclude<PositionWaitReason, "decided">;

export function positionConflict(
  sentPositionAt: string | null,
  fresh: (AnswerableInput & Pick<AmendmentDto, "position">) | null | undefined,
  stillInReview: boolean,
  rule: AcceptedAmendmentRule,
  context: PositionContext = {},
): PositionConflict {
  if (context.finalVoted) return "voted";
  if (!fresh) return "gone";
  if (stillInReview) {
    return seenPositionAt(fresh) !== sentPositionAt ? "answered" : "changed";
  }
  const reason = positionWaitReason(fresh, rule);
  if (reason === "decided") return "gone";
  return reason ?? "changed";
}

/**
 * The notice when an amendment leaves the review on its own, as the key
 * under `proponentReview`, read from the fresh amendment: one a
 * transactional replaced says so (the transactional is answered in its
 * place); anything else was decided or answered meanwhile.
 */
export function goneKey(
  fresh: Pick<AmendmentDto, "status"> | null | undefined,
): "gone" | "goneTransacted" {
  return fresh?.status === "transacted" ? "goneTransacted" : "gone";
}

/**
 * What the answer means under the document's rule, as the key under
 * `proponentReview.answer` that explains "Aceptar": incorporated into the
 * text without a vote, or voted by the assembly.
 */
export function acceptHelpKey(rule: AcceptedAmendmentRule): string {
  return rule === "incorporate" ? "acceptHelpIncorporate" : "acceptHelpVote";
}

/**
 * The toast after saving, as the key under `proponentReview.saved`: an
 * accepted amendment the server incorporated says so.
 */
export function savedKey(
  answer: ProponentAnswer,
  updated: Pick<AmendmentDto, "status" | "approvalMethod">,
): string {
  return answer === "accept" && isIncorporated(updated)
    ? "incorporated"
    : answer;
}

/**
 * The answer took an incorporated amendment out of the text: it was
 * incorporated before and is not any more.
 */
export function wasReopened(
  before: Pick<AmendmentDto, "status" | "approvalMethod">,
  after: Pick<AmendmentDto, "status" | "approvalMethod">,
): boolean {
  return isIncorporated(before) && !isIncorporated(after);
}

/**
 * The answer on record was given by the Mesa on the main presenter's behalf
 * (in the session, say), not by the member itself. Only for an answer: a
 * pending or hidden position says nothing about who will answer.
 */
export function answeredByMesa(
  amendment: Pick<AmendmentDto, "position">,
): boolean {
  return (
    positionAnswer(amendment) !== null &&
    amendment.position?.recordedBy === "mesa"
  );
}

/**
 * Where the state sentence of a step comes from, as the key under
 * `proponentReview.state`: what the answer leaves behind under the
 * document's rule. With `forMember` (the Mesa answering for the main
 * presenter) the sentence names the member instead of "you". An answer the
 * Mesa recorded says so (`ByMesa`): "La Mesa, en tu nombre, la ha
 * aceptado", or for the Mesa "La Mesa, en nombre de CEUM, la ha aceptado".
 */
export function stateKey(
  amendment: Pick<AmendmentDto, "position" | "status" | "approvalMethod">,
  rule: AcceptedAmendmentRule,
  forMember: boolean,
): string {
  const answer = positionAnswer(amendment);
  let key: string = answer ?? "pending";
  if (answer === "accept") {
    if (isIncorporated(amendment)) key = "incorporated";
    else if (rule === "vote") key = "acceptVote";
  }
  if (answeredByMesa(amendment)) key = `${key}ByMesa`;
  return forMember ? `${key}For` : key;
}

/**
 * The sentence a co-presenter reads for the main presenter's answer, as the
 * key under `proponentReview.coPresenter` (with `member` and, for an answer,
 * `date`):
 * - `hidden`: the viewer cannot see the answer yet (an incorporated one
 *   still says so, by its status);
 * - `pending`: not answered yet;
 * - `answered.<status>`: the main presenter answered ("CEA-AC la aceptó el
 *   5 nov");
 * - `answeredByMesa.<status>`: the Mesa answered on its behalf ("La Mesa,
 *   en nombre de CEA-AC, la aceptó el 5 nov").
 */
export function presenterAnswerKey(
  amendment: Pick<AmendmentDto, "position" | "status" | "approvalMethod">,
): string {
  if (isPositionHidden(amendment) && !isIncorporated(amendment)) {
    return "hidden";
  }
  const status = answerStatus(amendment);
  if (status === "pending") return "pending";
  return answeredByMesa(amendment)
    ? `answeredByMesa.${status}`
    : `answered.${status}`;
}

// Queue -------------------------------------------------------------------------

function toItem(amendment: AmendmentDto): ProponentReviewItem {
  return {
    id: amendment.id,
    amendment,
    answered: isPositionAnswered(amendment),
  };
}

/**
 * Everything the actor answers here, in text order: nothing once the
 * document is voted (`context.finalVoted`).
 */
export function proponentReviewItems(
  amendments: readonly AmendmentDto[],
  rule: AcceptedAmendmentRule,
  context: PositionContext = {},
): ProponentReviewItem[] {
  if (context.finalVoted) return [];
  return sortAmendments([...amendments])
    .filter((amendment) => isPositionReviewable(amendment, rule))
    .map(toItem);
}

/**
 * The main presenter's answers as a co-presenter reads them, in text order,
 * whoever looks (nothing depends on the viewer's capabilities, which a
 * co-presenter lacks): every presented, admitted amendment the main
 * presenter answered, settled or not, and every one it can answer now.
 * Amendments a transactional replaced are left out (the transactional
 * carries the answer that counts), as are the inadmissible ones. With
 * `answeredOnly` (the document was voted or closed) only the answers stay.
 */
export function presenterAnswerItems(
  amendments: readonly AmendmentDto[],
  rule: AcceptedAmendmentRule,
  options: { answeredOnly?: boolean } = {},
): ProponentReviewItem[] {
  return sortAmendments([...amendments])
    .filter((amendment) => {
      if (
        amendment.status === "draft" ||
        amendment.status === "transacted" ||
        amendment.admission !== "admitted"
      ) {
        return false;
      }
      if (isPositionAnswered(amendment) || isIncorporated(amendment)) {
        return true;
      }
      return !options.answeredOnly && isPositionAnswerable(amendment, rule);
    })
    .map(toItem);
}

export interface ProponentReviewProgress {
  /** Amendments answered (a position given). */
  answered: number;
  /** Amendments to answer, answered or not. */
  total: number;
}

/** The progress line: "3 de 12 respondidas". */
export function proponentReviewProgress(
  items: readonly ProponentReviewItem[],
): ProponentReviewProgress {
  return {
    answered: items.filter((item) => item.answered).length,
    total: items.length,
  };
}

/**
 * The answer cannot be seen by the viewer (positions hidden from it): not
 * the same as unanswered.
 */
export function isPositionHidden(
  amendment: Pick<AmendmentDto, "position">,
): boolean {
  return amendment.position === null;
}

/**
 * A co-presenter's progress line, over the answers it can see: one hidden
 * from it is neither answered nor waiting as far as it can tell.
 */
export function visibleAnswerProgress(
  items: readonly ProponentReviewItem[],
): ProponentReviewProgress {
  return proponentReviewProgress(
    items.filter((item) => !isPositionHidden(item.amendment)),
  );
}

function emptyCounts(): Record<ProponentPosition, number> {
  return { pending: 0, accept: 0, reject: 0, transact: 0 };
}

/** How many amendments got each answer, and how many are still pending. */
export function positionCounts(
  items: readonly ProponentReviewItem[],
): Record<ProponentPosition, number> {
  const counts = emptyCounts();
  for (const item of items) {
    counts[positionAnswer(item.amendment) ?? "pending"] += 1;
  }
  return counts;
}

/**
 * The answers on record over every presented amendment, decided or not
 * (for the summary once the document is voted and nothing can change).
 * Amendments a transactional replaced are left out: the transactional
 * carries the answer that counted.
 */
export function recordedPositionCounts(
  amendments: readonly Pick<AmendmentDto, "status" | "position">[],
): Record<ProponentPosition, number> {
  const counts = emptyCounts();
  for (const amendment of amendments) {
    if (amendment.status === "draft" || amendment.status === "transacted") {
      continue;
    }
    const answer = positionAnswer(amendment);
    if (answer) counts[answer] += 1;
  }
  return counts;
}

// Cursor ------------------------------------------------------------------------

/** Still waiting for the actor: not answered yet. */
export function isItemPending(item: ProponentReviewItem): boolean {
  return !item.answered;
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
 * "Enmienda 5 de 12": where the step sits in the whole review, so the total
 * matches the progress line ("3 de 12 respondidas") and hiding the answered
 * ones does not turn it into a countdown. Null when the step is not in the
 * review.
 */
export function stepCounter(
  items: readonly ProponentReviewItem[],
  id: string | null,
): { current: number; total: number } | null {
  const index = items.findIndex((candidate) => candidate.id === id);
  if (index < 0) return null;
  return { current: index + 1, total: items.length };
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

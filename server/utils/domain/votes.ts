import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { votes } from "../../db/schema";
import type { Executor } from "./events";
import type { VoteDto } from "~~/shared/types/api";

/**
 * The one shape of a stored vote on its way out, for every path that
 * records or reads votes (a document's final vote, an amendment's outcome
 * and admission, a decision, an agenda item's own vote, the live state and
 * the control sheet). It imports nothing from ./documents or ./amendments,
 * so all of them share it without an import cycle.
 */

export type VoteRow = typeof votes.$inferSelect;

/**
 * The i18n keys (`data.messageKey`) of the refusals the vote endpoints
 * answer, worded by useApi().notifyError in the console and the sheet.
 */
export const VOTE_MESSAGE_KEYS = {
  /** Voiding a vote or changing its unanimity once the assembly closed. */
  closed: "common.errors.voteAssemblyClosed",
  /** Voiding it again, or putting a voided vote on screen. */
  voided: "common.errors.voteVoided",
  /** Voiding a vote that is not on an agenda item. */
  notVoidable: "common.errors.voteNotVoidable",
  /** Unanimity on a vote no longer in force (voided, annulled). */
  notInForce: "common.errors.voteNotInForce",
  /** Unanimity on a vote other than an assent on an item or a document. */
  unanimityRefused: "common.errors.voteUnanimityRefused",
} as const;

export function toVoteDto(vote: VoteRow): VoteDto {
  return {
    id: vote.id,
    subjectType: vote.subjectType,
    subjectId: vote.subjectId,
    method: vote.method,
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
    blank: vote.blank,
    invalid: vote.invalid,
    notCast: vote.notCast,
    present: vote.present,
    majority: vote.majority,
    result: vote.result,
    note: vote.note,
    question: vote.question,
    unanimous: vote.unanimous,
    options: vote.options ?? null,
    winningOption: vote.winningOption ?? null,
    tieResolution: vote.tieResolution ?? null,
    ballots: vote.ballots ?? null,
    winnerOutcome:
      vote.options && vote.winningOption !== null
        ? (vote.winnerOutcome ?? "approve")
        : null,
    recordedAt: vote.recordedAt.toISOString(),
    updatedAt: vote.updatedAt.toISOString(),
    voidedAt: vote.voidedAt ? vote.voidedAt.toISOString() : null,
  };
}

/**
 * A vote on an agenda item as one reader gets it: without its question when
 * that reader gets the item without its title (`titleHidden`, the item ids
 * hiddenTitleItemIds gives its agenda), since the question may repeat that
 * title. Clients word a vote without one «Votación del punto».
 */
export function toItemVoteDto(
  vote: VoteRow,
  titleHidden: ReadonlySet<string>,
): VoteDto {
  const dto = toVoteDto(vote);
  return vote.subjectType === "agenda_item" && titleHidden.has(vote.subjectId)
    ? { ...dto, question: null }
    : dto;
}

/**
 * Every vote on an agenda item of the assembly, voided ones too, oldest
 * first (by the time it was recorded, then by id). Callers keep only the
 * items their reader gets.
 */
export async function loadItemVoteRows(
  assemblyId: string,
  executor: Executor = db,
): Promise<VoteRow[]> {
  return executor
    .select()
    .from(votes)
    .where(
      and(
        eq(votes.assemblyId, assemblyId),
        eq(votes.subjectType, "agenda_item"),
      ),
    )
    .orderBy(asc(votes.recordedAt), asc(votes.id));
}

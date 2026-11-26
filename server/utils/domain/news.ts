import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../../db";
import {
  agreementRecordSignings,
  amendmentAuthors,
  amendmentSources,
  amendments,
  documents,
  events,
  members,
  transactionalRevisions,
} from "../../db/schema";
import type {
  AcceptanceDecision,
  AcceptanceRole,
  AcceptedAmendmentRule,
  AdmissionStatus,
  AmendmentKind,
  ApprovalMethod,
  AssemblySettings,
  AssemblyStatus,
  AmendmentStatus,
  ProponentPosition,
} from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { MeWorkAssemblyRef, MeWorkNewsDto } from "~~/shared/types/api";
import { compareAmendmentCodes } from "~~/shared/utils/amendmentOrder";
import { moderates, reviewsAmendments } from "~~/shared/utils/permissionRules";
import {
  positionsPublicSince,
  type PositionsPublication,
} from "~~/shared/utils/positions";
import { toMemberRef } from "../members/dto";
import type { Actor } from "./actor";
import { canSeeLoadedAmendment, findAmendmentsByIds } from "./amendments";
import type { SIGNATURE_VOIDED_EVENT } from "./agreementsSignedFile";
import {
  impersonatedByFor,
  loadImpersonators,
  seesImpersonator,
} from "./impersonators";
import { coPresentedBy, withCoProponentIds } from "./presenters";
import { authorsApproval, countPositionsPending } from "./reviewState";
import {
  canSeeDocument,
  canSeePositions,
  isDocumentPresenter,
  redactMember,
  seesOthersValidatedAmendments,
  seesUnpublishedPositions,
} from "./visibility";

/**
 * The notices («Avisos», GET /api/me/notices, MeNoticesDto.items): what
 * others decided about the work of the user's member in the last days, and
 * the latest about the amendments for the Mesa (docs/api.md, "Notices").
 * - For the presenters of a document (main and co-presenters): the answers
 *   to its amendments another presenter gave, or the Mesa for them
 *   (position_changed).
 * - For the authors of an amendment: the presenters' answer to it
 *   (position_changed), when the assembly's policy lets them see positions
 *   (canSeePositions).
 * - For the authors of an amendment: the main authors' answers to the
 *   transactionals over it, and to the transactionals the member proposed
 *   (acceptance_recorded).
 * - For the authors of an amendment: what the Secretaría, the Mesa or the
 *   assembly settled about it (NEWS_OUTCOME_TYPES). A transactional closed
 *   because a main author rejected it is said by that rejection
 *   (acceptance_recorded), so its withdrawal is left out.
 * - For the authors of an amendment a transactional groups (its parties
 *   among them): that transactional closing by itself, because what it
 *   groups was settled or replaced by another one (isAutomaticClosure),
 *   and coming back by itself, because what closed it was reopened
 *   (isAutomaticRestore).
 * - For the authors of an amendment a transactional replaced: that
 *   transactional withdrawn once in force (amendment_withdrawn with
 *   `replacedSources`, by the Mesa or by an author whose own amendments
 *   were the only ones) or lapsed by the Mesa once in force
 *   (amendment_lapsed with `replacedSources`), since their amendment stays
 *   replaced; only the authors of the amendments in its
 *   `replacedSourceIds` are told (isReplacingClosure, replacedOwnSource).
 *   It never reaches them by email: they are not its authors.
 * - For the presenters of a document (main and co-presenters): what the
 *   Secretaría, the Mesa or the assembly settled about it
 *   (NEWS_DOCUMENT_TYPES), with no amendment.
 * - For the presenters of a document (main and co-presenters), about the
 *   amendments to it they did not write (isPresenterNews): each new one,
 *   once, from the first event that let them read it (amendment_validated
 *   when they read it validated and unpublished, as an office of the CEA
 *   or the presenters of a transactional do, or when validated and
 *   published at once, amendment_published otherwise; isPresenterCandidate,
 *   presenterNewsState, isRepeatedArrival, presenterRowsOnce), except a transactional
 *   one of them proposed, which was their answer
 *   (isPresentersOwnTransactional, as presenter_transactional in the
 *   email rules); and one they could read withdrawn, lapsed or replaced by
 *   a transactional, by its latest such event and only while it stays so
 *   (presenterClosureStands). A withdrawn amendment stays out for whoever may not
 *   read it (canSeeLoadedAmendment), plain presenters included. Rows of
 *   the same kind about one document within NEWS_RUN_MS of each other
 *   become one (groupNewsRuns: "12 enmiendas nuevas"), before the cut to
 *   NEWS_LIMIT.
 * - For the same readers as the main presenter's answers: the automatic
 *   answer to a formal amendment (isAutomaticAnswer), which is nobody's
 *   decision either (`by` null, `automatic`).
 * - For an account that moderates (session:moderate: the Mesa, and the
 *   Secretaría and the Presidencia, which hold every key), with or without
 *   a member, about the amendments of every assembly read (mesaNewsScope,
 *   `asMesa`): the Secretaría's validations, unless the account validates
 *   amendments itself; a transactional every party accepted, and an
 *   inclusion in one; a party's rejection of a transactional; and an
 *   amendment withdrawn by its author (mesaNewsKind). Not what the Mesa
 *   records from the console, nor the account's own acts. Read apart with
 *   their own room (NEWS_MESA_CANDIDATES), once per amendment and kind
 *   (mesaRowsOnce), only while they stand (mesaNewsStands), and grouped by
 *   document and kind like the presenters' rows (a late validation apart
 *   from the others, newsRunKey). An event the member's
 *   scopes tell is told that way, and a validation the member is told as a
 *   presenter or an author is not told again (mesaRowRepeatsMember).
 * - For an account that manages documents (document:manage, signingNewsScope:
 *   the Secretaría and the Presidencia by default), with or without a
 *   member: an acta whose signed PDF was taken away
 *   (document_signature_voided: a correction of form, its final vote
 *   annulled or that vote's unanimity changed) must be signed again. Read
 *   apart (NEWS_SIGNING_CANDIDATES), once per document (signingRowsOnce),
 *   only while it is not signed again for its text in force
 *   (signatureVoidStands), and also when the account's own act caused it:
 *   it is a pending task, not news of someone else's act. Never by email.
 * Decisions the member took itself are left out, and so is anything the
 * actor cannot see. A transactional closing or coming back by itself is
 * nobody's decision (isAutomaticChange): it names nobody (`by` null) and
 * reaches its authors and parties also when their own act on what it
 * grouped closed it or brought it back. What an Admin did while
 * acting as the user's account (events.impersonation_id) is not the user's
 * own decision either, so it reaches that account's news.
 */

/** How far back the news go. */
export const NEWS_WINDOW_DAYS = 30;
/** At most this many news, newest first. */
export const NEWS_LIMIT = 30;
/**
 * Candidate events read for every scope but the presenters' and the Mesa's
 * ones, with room for the ones the checks leave out.
 */
const NEWS_CANDIDATES = NEWS_LIMIT * 3;
/**
 * Candidate events read for the presenters' scope (NEWS_PRESENTER_TYPES),
 * apart from the rest, so the amendments published at a deadline (150 is
 * usual) reach no group cut short. The query reads one arrival per
 * amendment, the event that can make it new to this reader
 * (isPresenterCandidate), so this is room for two events per amendment
 * (its arrival and a closure) of 150 amendments. When it fills, nothing
 * older than its oldest event is kept from the other query (mergeNewsRows).
 */
export const NEWS_PRESENTER_CANDIDATES = 300;
/** Presenters' rows of one kind this close to each other make one row. */
export const NEWS_RUN_MS = 10 * 60 * 1000;
/** Codes a grouped row names (MeWorkNewsDto.amendments). */
export const NEWS_GROUP_CODES = 3;

/** Events about the member's own amendments that count as news. */
export const NEWS_OUTCOME_TYPES = [
  "amendment_validated",
  "amendment_validation_undone",
  "amendment_published",
  "amendment_correction_requested",
  "amendment_reclassified",
  "amendment_authors_changed",
  "amendment_admitted",
  "amendment_inadmissible",
  "amendment_approved",
  "amendment_rejected",
  "amendment_withdrawn",
  "amendment_lapsed",
  "amendment_transacted",
  "amendment_reopened",
] as const;

/**
 * Events about an amendment to a document the member presents that count
 * as news for its presenters (isPresenterNews): the amendment new to them
 * (NEWS_ARRIVAL_TYPES) and closed by someone else.
 */
export const NEWS_PRESENTER_TYPES = [
  "amendment_validated",
  "amendment_published",
  "amendment_withdrawn",
  "amendment_lapsed",
  "amendment_transacted",
] as const;

/** The presenters' events that make an amendment new to them. */
export const NEWS_ARRIVAL_TYPES = [
  "amendment_validated",
  "amendment_published",
] as const;

function isArrival(type: string): boolean {
  return (NEWS_ARRIVAL_TYPES as readonly string[]).includes(type);
}

/** Events about the member's own documents that count as news. */
export const NEWS_DOCUMENT_TYPES = [
  "document_published",
  "document_correction_requested",
  "document_voted",
  "document_status_changed",
] as const;

/**
 * Events that may close a transactional by itself, or bring it back
 * (isAutomaticChange), and the ones that close it once it replaced what it
 * groups (isReplacingClosure).
 */
const AUTOMATIC_TYPES = [
  "amendment_withdrawn",
  "amendment_lapsed",
  "amendment_reopened",
] as const;

const DAY = 24 * 60 * 60 * 1000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A transactional closed by itself, not by anyone's decision about it: an
 * amendment it groups was settled (amendment_withdrawn with
 * `by: "sources_closed"`), or another transactional replaced them first
 * (amendment_lapsed with `reason: "sources_transacted"`).
 */
export function isAutomaticClosure(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  return (
    (type === "amendment_withdrawn" && payload.by === "sources_closed") ||
    (type === "amendment_lapsed" &&
      (payload.reason === "sources_transacted" ||
        payload.reason === "sources_inadmissible")) ||
    type === "transactional_source_dropped"
  );
}

/**
 * A transactional back by itself, not by anyone's decision about it: an
 * amendment it groups was reopened before the final vote and all of them are
 * open again (amendment_reopened with `reason: "source_reopened"`,
 * reopenTransactionalsClosedBy).
 */
export function isAutomaticRestore(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  return type === "amendment_reopened" && payload.reason === "source_reopened";
}

/**
 * The automatic answer to a formal amendment, not the main presenter's
 * decision (autoAcceptFormal in amendments.ts): accepted by itself
 * (position_changed with `by: "auto"`), incorporated by that acceptance
 * (amendment_approved with `reason: "formal"`), or back to unanswered and
 * out of the text once it stopped being formal (position_changed and
 * amendment_reopened with `by: "auto"`).
 */
export function isAutomaticAnswer(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  return (
    ((type === "position_changed" || type === "amendment_reopened") &&
      payload.by === "auto") ||
    (type === "amendment_approved" && payload.reason === "formal")
  );
}

/**
 * A transactional withdrawn or lapsed after it had replaced what it groups
 * (`replacedSources`, from replacesSourcesNow: withdrawAmendment, or the
 * Mesa's withdrawal or lapse from the console or in bulk in
 * recordAmendmentOutcome): those amendments stay `transacted`, so their
 * authors are told although someone decided it.
 */
export function isReplacingClosure(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  return (
    (type === "amendment_withdrawn" || type === "amendment_lapsed") &&
    payload.replacedSources === true
  );
}

/**
 * A replacing closure (isReplacingClosure) that replaced one of
 * `ownSourceIds`, the member's amendments the transactional groups: it is
 * news only for the authors of the amendments it did replace
 * (`replacedSourceIds`), not for one it left open, such as a late one still
 * waiting for admission.
 */
export function replacedOwnSource(
  type: string,
  payload: Record<string, unknown>,
  ownSourceIds: readonly string[],
): boolean {
  if (!isReplacingClosure(type, payload)) return false;
  const replaced = Array.isArray(payload.replacedSourceIds)
    ? (payload.replacedSourceIds as unknown[])
    : [];
  return ownSourceIds.some((id) => replaced.includes(id));
}

/** A transactional that closed or came back by itself. */
export function isAutomaticChange(
  type: string,
  payload: Record<string, unknown>,
): boolean {
  return isAutomaticClosure(type, payload) || isAutomaticRestore(type, payload);
}

/** Why an event concerns the member (loadWorkNews). */
export interface NewsScope {
  /** A document the member presents (main presenter or co-presenter). */
  presented: boolean;
  /**
   * An amendment to a document the member presents (main presenter or
   * co-presenter): any of them answers it, and the others are told.
   */
  answered: boolean;
  /** An amendment the member wrote (main author or co-author). */
  authored: boolean;
  /** A transactional over an amendment the member wrote. */
  overOwn: boolean;
  /** With `overOwn`, the member's amendments that transactional groups. */
  ownSourceIds: readonly string[];
}

/**
 * Whether an event is news for the member, by what it is about (`scope`).
 * Visibility and whether someone else decided it are checked apart
 * (loadWorkNews, isOthersDecision).
 */
export function isNewsEvent(
  event: {
    entityType: string;
    type: string;
    payload: Record<string, unknown>;
  },
  scope: NewsScope,
): boolean {
  const { type, payload } = event;
  if (event.entityType === "document") {
    return (
      scope.presented &&
      (NEWS_DOCUMENT_TYPES as readonly string[]).includes(type)
    );
  }
  if (event.entityType !== "amendment") return false;
  if (type === "position_changed") return scope.answered || scope.authored;
  if (type === "acceptance_recorded") return scope.authored || scope.overOwn;
  if (!(NEWS_OUTCOME_TYPES as readonly string[]).includes(type)) return false;
  // The rejection that closed it already says it.
  if (type === "amendment_withdrawn" && payload.by === "author_rejection") {
    return false;
  }
  return (
    scope.authored ||
    (scope.overOwn &&
      (isAutomaticChange(type, payload) ||
        replacedOwnSource(type, payload, scope.ownSourceIds))) ||
    (scope.answered &&
      (NEWS_PRESENTER_TYPES as readonly string[]).includes(type))
  );
}

/**
 * Whether an event reaches the member only as a presenter of the amended
 * document (NEWS_PRESENTER_TYPES): not about an amendment it wrote, nor
 * news for it otherwise. Those rows say "a tu documento", collapse to one
 * per amendment (presenterRowsOnce) and group (groupNewsRuns).
 */
export function isPresenterNews(
  event: {
    entityType: string;
    type: string;
    payload: Record<string, unknown>;
  },
  scope: NewsScope,
): boolean {
  return (
    event.entityType === "amendment" &&
    scope.answered &&
    !scope.authored &&
    (NEWS_PRESENTER_TYPES as readonly string[]).includes(event.type) &&
    isNewsEvent(event, scope) &&
    !isNewsEvent(event, { ...scope, answered: false })
  );
}

/**
 * Whether the presenters' query reads an event about an amendment to the
 * reader's document (NEWS_PRESENTER_TYPES): of its arrivals, only the one
 * that can make it new to this reader, so rows it can never be told do not
 * fill the query's room (NEWS_PRESENTER_CANDIDATES). `readsValidated`: the
 * reader reads the amendment validated and unpublished (a transactional, or
 * seesOthersValidatedAmendments), so it is told at validation and its later
 * publication is no arrival (isRepeatedArrival). Otherwise a validation
 * counts only when it published the amendment at once (`publish: true`,
 * with no amendment_published of its own). presenterCandidatesWhere is its
 * SQL twin.
 */
export function isPresenterCandidate(
  event: { type: string; payload: Record<string, unknown> },
  readsValidated: boolean,
): boolean {
  switch (event.type) {
    case "amendment_validated":
      return readsValidated || event.payload.publish === true;
    case "amendment_published":
      return !readsValidated;
    default:
      return (NEWS_PRESENTER_TYPES as readonly string[]).includes(event.type);
  }
}

/** The events isPresenterCandidate keeps, about the amendments `ids`. */
function presenterCandidatesWhere(
  ids: readonly string[],
  readsValidated: boolean,
): SQL | undefined {
  if (ids.length === 0) return undefined;
  const closures = NEWS_PRESENTER_TYPES.filter((type) => !isArrival(type));
  return and(
    eq(events.entityType, "amendment"),
    inArray(events.entityId, [...ids]),
    readsValidated
      ? inArray(events.type, [...closures, "amendment_validated"])
      : or(
          inArray(events.type, [...closures, "amendment_published"]),
          and(
            eq(events.type, "amendment_validated"),
            sql`${events.payload}->>'publish' = 'true'`,
          ),
        ),
  );
}

/**
 * A publication that repeats an arrival already told: the amendment was
 * validated before it and the reader could read it then (`couldRead`, asked
 * about the validated, unpublished state), so it was told at validation,
 * also when that event has left the window or the query's room.
 */
export function isRepeatedArrival(
  type: string,
  amendment: { validatedAt: Date | null },
  at: Date,
  couldRead: (state: {
    status: "submitted";
    validatedAt: Date;
    publishedAt: null;
  }) => boolean,
): boolean {
  return (
    type === "amendment_published" &&
    amendment.validatedAt !== null &&
    amendment.validatedAt.getTime() < at.getTime() &&
    couldRead({
      status: "submitted",
      validatedAt: amendment.validatedAt,
      publishedAt: null,
    })
  );
}

/**
 * The state a presenter's row is about, for canSeeLoadedAmendment to say
 * whether the reader could read the amendment then: validated and not
 * published yet (amendment_validated: an office of the CEA, or the
 * presenters of a transactional, read it; everyone else waits for its
 * publication), or published at once (amendment_validated with
 * `publish: true`, which records no amendment_published), published
 * (amendment_published), or still open as it was validated and published
 * before it closed (a closure, so only what the reader saw while it was
 * open counts). Visibility today is checked apart: a withdrawn amendment
 * stays out for whoever may not read it.
 */
export function presenterNewsState(
  type: string,
  payload: Record<string, unknown>,
  amendment: { validatedAt: Date | null; publishedAt: Date | null },
  at: Date,
): { status: "submitted"; validatedAt: Date | null; publishedAt: Date | null } {
  if (type === "amendment_validated") {
    return {
      status: "submitted",
      validatedAt: at,
      publishedAt: payload.publish === true ? at : null,
    };
  }
  if (type === "amendment_published") {
    return {
      status: "submitted",
      validatedAt: amendment.validatedAt ?? at,
      publishedAt: at,
    };
  }
  return {
    status: "submitted",
    validatedAt: amendment.validatedAt,
    publishedAt: amendment.publishedAt,
  };
}

/**
 * A transactional one of the document's presenters (main or co-presenter)
 * proposed (`meta.proposerMemberId`): that was their answer, so its
 * arrival is no news to them (user's decision of 2026-11-21, as
 * presenter_transactional in server/utils/notifications/rules.ts). One the
 * Mesa presented on nobody's behalf has no proposer and stays news.
 */
export function isPresentersOwnTransactional(
  amendment: { kind: string; meta: unknown },
  document: {
    proponentMemberId: string | null;
    coProponentMemberIds: string[];
  },
): boolean {
  if (amendment.kind !== "transactional") return false;
  const meta = amendment.meta as { proposerMemberId?: unknown } | null;
  const proposer = text(meta?.proposerMemberId);
  return (
    proposer !== null &&
    (proposer === document.proponentMemberId ||
      document.coProponentMemberIds.includes(proposer))
  );
}

/**
 * The presenters' rows once per amendment (rows newest first): of its
 * arrivals (validated, published) only the earliest stays, the moment the
 * reader could first read it; of its closures only the latest, so a lapse
 * the Mesa undid and recorded again counts once. Rows already filtered by
 * visibility, so an amendment validated where the reader could not read it
 * is told by its publication.
 */
export function presenterRowsOnce<
  T extends { entityId: string; type: string; presenter: boolean },
>(rows: readonly T[]): T[] {
  const kept = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!row.presenter) return;
    const key = `${isArrival(row.type) ? "arrival" : "closure"}:${row.entityId}`;
    // The earliest arrival is the last one; the latest closure the first.
    if (isArrival(row.type) || !kept.has(key)) kept.set(key, index);
  });
  return rows.filter(
    (row, index) =>
      !row.presenter ||
      kept.get(
        `${isArrival(row.type) ? "arrival" : "closure"}:${row.entityId}`,
      ) === index,
  );
}

/**
 * Whether a closure told to the presenters still stands: the amendment is
 * still withdrawn, lapsed or transacted. The presenters are not told of a
 * reopening, so one back in debate must not read as closed. Arrivals and
 * other events always stand.
 */
export function presenterClosureStands(type: string, status: string): boolean {
  switch (type) {
    case "amendment_withdrawn":
      return status === "withdrawn";
    case "amendment_lapsed":
      return status === "lapsed";
    case "amendment_transacted":
      return status === "transacted";
    default:
      return true;
  }
}

// The Mesa's scope ---------------------------------------------------------------

/**
 * What the Mesa's scope tells (MesaNewsScope): an amendment validated by
 * the Secretaría, a transactional every party accepted (`ready`: by the
 * last party's acceptance, or presented with its proposer as the only
 * party), an inclusion in a transactional every party accepted
 * (`revision_ready`), a party's rejection of a transactional, and an
 * amendment withdrawn by its author.
 */
export type MesaNewsKind =
  "validated" | "ready" | "revision_ready" | "rejected" | "withdrawn";

/**
 * The Mesa's scope (stage 4 of «Avisos»): an account that moderates
 * (session:moderate, which the Secretaría and the Presidencia hold too) is
 * told the latest about the amendments of the assemblies the home page
 * covers, with or without a member. `validated`: it is told the
 * Secretaría's validations, unless it validates amendments itself
 * (amendment:review or amendment:manage), which «Validación» already shows
 * it (user's decision of 2026-11-25). Null for an account that does not
 * moderate.
 */
export interface MesaNewsScope {
  validated: boolean;
}

/** The Mesa's scope of an account, by its keys (MesaNewsScope). */
export function mesaNewsScope(actor: Pick<Actor, "can">): MesaNewsScope | null {
  if (!moderates(actor.can)) return null;
  return { validated: !reviewsAmendments(actor.can) };
}

/**
 * Candidate events read for the Mesa's scope, apart from the rest, so the
 * validations of a deadline (150 is usual) reach no group cut short: room
 * for two events per amendment of 150 amendments. When it fills, only the
 * Mesa's older events are left out: the member's are kept
 * (mergeNewsRows, `cutsOthers: false`), so a deadline's validations never
 * push the member's own news out.
 */
export const NEWS_MESA_CANDIDATES = 300;

/**
 * What an event tells the Mesa (MesaNewsKind), by its type and payload, or
 * null when it tells it nothing. What the Mesa itself records from the
 * console is left out, so the Mesa's accounts are not told each other's
 * clicks: a validation as it presents its own transactional
 * (`method: "mesa"`), a withdrawal (`by: "moderator"`), and an answer it
 * records for a party (`recordedForMemberId`), also when that answer made
 * an inclusion ready (transactional_revision_ready with it). A transactional a main
 * author's rejection closed is told by that rejection: its withdrawal
 * (`by: "author_rejection"`) is no author's. Whether the amendment is a
 * transactional, whether an acceptance was the last one and whether it
 * still stands are checked on the loaded amendment (mesaNewsStands).
 * mesaCandidatesWhere is its SQL twin.
 */
export function mesaNewsKind(
  event: { entityType: string; type: string; payload: Record<string, unknown> },
  scope: MesaNewsScope,
): MesaNewsKind | null {
  if (event.entityType !== "amendment") return null;
  const { payload } = event;
  switch (event.type) {
    case "amendment_validated":
      return scope.validated && payload.method !== "mesa" ? "validated" : null;
    case "amendment_withdrawn":
      return payload.by === "author" ? "withdrawn" : null;
    case "acceptance_recorded":
      if (text(payload.recordedForMemberId)) return null;
      if (payload.decision === "rejected") return "rejected";
      return payload.decision === "accepted" ? "ready" : null;
    case "amendment_submitted":
      // A transactional whose proposer was its only party: straight to the
      // Secretaría (as transactional_ready in the email rules). One the
      // Mesa presents is admitted at once.
      return payload.awaitsAuthors !== true && payload.admission !== "admitted"
        ? "ready"
        : null;
    case "transactional_revision_ready":
      // Made ready by an answer the Mesa recorded for a party. One recorded
      // before 2026-11-26 does not say so, and is told.
      return text(payload.recordedForMemberId) ? null : "revision_ready";
    default:
      return null;
  }
}

/**
 * The events mesaNewsKind may keep, over the assemblies already filtered by
 * the caller: a transactional's presentation only (a subquery on
 * `amendments.kind`), so the ordinary amendments presented at a deadline
 * never fill the room.
 */
function mesaCandidatesWhere(scope: MesaNewsScope): SQL {
  const onAmendments = eq(events.entityType, "amendment");
  const transactionalIds = db
    .select({ id: amendments.id })
    .from(amendments)
    .where(eq(amendments.kind, "transactional"));
  return and(
    onAmendments,
    or(
      ...(scope.validated
        ? [
            and(
              eq(events.type, "amendment_validated"),
              sql`${events.payload}->>'method' is distinct from 'mesa'`,
            ),
          ]
        : []),
      and(
        eq(events.type, "amendment_withdrawn"),
        sql`${events.payload}->>'by' = 'author'`,
      ),
      and(
        eq(events.type, "acceptance_recorded"),
        sql`${events.payload}->>'decision' in ('accepted', 'rejected')`,
        sql`${events.payload}->>'recordedForMemberId' is null`,
      ),
      and(
        eq(events.type, "amendment_submitted"),
        sql`${events.payload}->>'awaitsAuthors' is distinct from 'true'`,
        sql`${events.payload}->>'admission' is distinct from 'admitted'`,
        inArray(events.entityId, transactionalIds),
      ),
      and(
        eq(events.type, "transactional_revision_ready"),
        sql`${events.payload}->>'recordedForMemberId' is null`,
      ),
    ),
  )!;
}

/**
 * Whether an acceptance (`payload.memberId`) is the one that made a
 * transactional accepted by every party: it is accepted now
 * (authorsApproval) and that party answered last (`decidedAt`). An
 * earlier party's acceptance is no news of a ready transactional, also when
 * the last one was the reader's own or recorded from the console, which
 * are left out.
 */
export function completesAcceptance(
  payload: Record<string, unknown>,
  amendment: {
    kind: AmendmentKind;
    acceptances: {
      memberId: string;
      role: AcceptanceRole;
      decision: AcceptanceDecision;
      decidedAt: Date | null;
    }[];
  },
): boolean {
  if (authorsApproval(amendment) !== "accepted") return false;
  let last: { memberId: string; at: number } | null = null;
  for (const party of amendment.acceptances) {
    if (party.role !== "author" || party.decidedAt === null) continue;
    const at = party.decidedAt.getTime();
    if (last === null || at > last.at) last = { memberId: party.memberId, at };
  }
  return last !== null && last.memberId === text(payload.memberId);
}

/**
 * Whether a row of the Mesa's scope still stands on the amendment as it is
 * now: a validation not undone; a withdrawal not reopened; a transactional
 * ready while it is still undecided (and, for an acceptance, only the one
 * that completed it, completesAcceptance); an inclusion ready while the
 * transactional is undecided and that inclusion (`payload.revisionId`,
 * whose status is `revisionStatus`) still waits for the Secretaria's
 * validation, so one applied, cancelled or missing is no longer told. A
 * party's rejection always stands: it closed the transactional.
 */
export function mesaNewsStands(
  kind: MesaNewsKind,
  row: { type: string; payload: Record<string, unknown> },
  amendment: Parameters<typeof completesAcceptance>[1] & {
    status: AmendmentStatus;
    validatedAt: Date | null;
  },
  revisionStatus?: string,
): boolean {
  switch (kind) {
    case "validated":
      return amendment.validatedAt !== null;
    case "withdrawn":
      return amendment.status === "withdrawn";
    case "rejected":
      return true;
    case "ready":
      return (
        amendment.kind === "transactional" &&
        amendment.status === "submitted" &&
        (row.type !== "acceptance_recorded" ||
          completesAcceptance(row.payload, amendment))
      );
    case "revision_ready":
      return (
        amendment.kind === "transactional" &&
        amendment.status === "submitted" &&
        revisionStatus === "pending_validation"
      );
  }
}

/**
 * Whether a row of the Mesa's scope is someone else's act: not this
 * account's (unless an Admin did it acting as it), nor, for an account
 * with a member, that member's through another account (isOthersDecision).
 */
export function isMesaOthersAct(
  event: Parameters<typeof isOthersDecision>[0],
  actor: { userId: string; memberId: string | null },
): boolean {
  if (actor.memberId !== null) {
    return isOthersDecision(event, {
      userId: actor.userId,
      memberId: actor.memberId,
    });
  }
  return event.actorUserId === actor.userId
    ? Boolean(event.impersonationId)
    : true;
}

/**
 * The Mesa's rows once per amendment and kind (rows newest first): the
 * latest stays, so a validation undone and done again, or a transactional
 * that came back ready, counts once. Other rows pass.
 */
export function mesaRowsOnce<
  T extends { entityId: string; mesa: MesaNewsKind | null },
>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.mesa === null) return true;
    const key = `${row.mesa}:${row.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether the reader's member scope already tells what a row of the Mesa's
 * scope would: a validation of an amendment to a document the member
 * presents (its arrival, isPresenterNews) or that it wrote (its own
 * news). The member's sentence stays, the Mesa's is left out.
 */
export function mesaRowRepeatsMember(
  kind: MesaNewsKind,
  amendmentId: string,
  member: {
    answeredIds: ReadonlySet<string>;
    authoredIds: ReadonlySet<string>;
  },
): boolean {
  return (
    kind === "validated" &&
    (member.answeredIds.has(amendmentId) || member.authoredIds.has(amendmentId))
  );
}

/**
 * Why an event is news for the reader, when it is: through the member's
 * scopes (`scope`, isNewsEvent; `presenter` for a presenter's row), whose
 * sentence names "tu enmienda", first; else through the Mesa's (`mesa`,
 * mesaNewsKind), unless the member's scopes already tell the same
 * (mesaRowRepeatsMember). An account without a member has empty scopes.
 * Null when it is news for neither.
 */
export function newsRowRole(
  event: {
    entityType: string;
    entityId: string;
    type: string;
    payload: Record<string, unknown>;
  },
  scope: NewsScope,
  mesa: MesaNewsScope | null,
  member: {
    answeredIds: ReadonlySet<string>;
    authoredIds: ReadonlySet<string>;
  },
): { presenter: boolean; mesa: MesaNewsKind | null } | null {
  if (isNewsEvent(event, scope)) {
    return { presenter: isPresenterNews(event, scope), mesa: null };
  }
  const kind = mesa ? mesaNewsKind(event, mesa) : null;
  return kind !== null && !mesaRowRepeatsMember(kind, event.entityId, member)
    ? { presenter: false, mesa: kind }
    : null;
}

// The signers' scope ------------------------------------------------------------

/**
 * The event that tells the managers a signed acta must be signed again
 * (SIGNATURE_VOIDED_EVENT in agreementsSignedFile.ts, typed against it).
 */
export const NEWS_SIGNATURE_VOIDED: typeof SIGNATURE_VOIDED_EVENT =
  "document_signature_voided";

/**
 * Candidate events read for the signers' scope, apart from the rest: one
 * notice per document, so this is room for several corrections of each of
 * the few actas an assembly signs. It cuts only itself (mergeNewsRows,
 * `cutsOthers: false`).
 */
export const NEWS_SIGNING_CANDIDATES = NEWS_LIMIT * 2;

/**
 * The signers' scope: an account that manages documents (document:manage,
 * which the Secretaría and the Presidencia hold; canManageDocuments, read
 * off the keys so the notices never load the auth modules) signs the
 * approved actas, so it is told, with or without a member, when one lost
 * its signed PDF and must be signed again.
 */
export function signingNewsScope(actor: Pick<Actor, "can">): boolean {
  return actor.can(PERMISSION_KEYS.DOCUMENT_MANAGE);
}

/** Whether an event is a signers' notice for an account with that scope. */
export function isSigningNews(
  event: { entityType: string; type: string },
  signing: boolean,
): boolean {
  return (
    signing &&
    event.entityType === "document" &&
    event.type === NEWS_SIGNATURE_VOIDED
  );
}

/** The events isSigningNews keeps. */
function signingCandidatesWhere(): SQL {
  return and(
    eq(events.entityType, "document"),
    eq(events.type, NEWS_SIGNATURE_VOIDED),
  )!;
}

/**
 * Whether a signers' notice still stands: the document is not signed again
 * for its text in force, as loadSignedRecordFile (agreementsSignedFile.ts)
 * reads a signature: a signed PDF, its moment, and the version it signed
 * being the document's consolidated one. With no signing row it stands.
 * Only an approved text is signed (only an approving final vote writes a
 * consolidated version): with none in force (the final vote annulled, or a
 * new one rejected it) there is nothing to sign, and it waits hidden until
 * a new approval.
 */
export function signatureVoidStands(
  document: { consolidatedVersionId: string | null },
  signed:
    | {
        url: string | null;
        signedAt: Date | null;
        versionId: string | null;
      }
    | undefined,
): boolean {
  if (document.consolidatedVersionId === null) return false;
  return !(
    signed?.url &&
    signed.signedAt &&
    document.consolidatedVersionId !== null &&
    signed.versionId === document.consolidatedVersionId
  );
}

/**
 * The signers' rows once per document (rows newest first): the latest
 * stays, whose reason is the last change that took the signature away.
 * Other rows pass.
 */
export function signingRowsOnce<
  T extends { entityId: string; signing: boolean },
>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.signing) return true;
    if (seen.has(row.entityId)) return false;
    seen.add(row.entityId);
    return true;
  });
}

/**
 * Whether the amendment still waits for the main presenter's answer and the
 * reader's member is that main presenter (MeWorkNewsDto.awaitsAnswer):
 * presented, undecided, unanswered and answerable now (countPositionsPending,
 * positionBlocker: validated and published, or only validated when an
 * office of the CEA presents the document; a transactional accepted by
 * every main author), in a document not voted yet. Co-presenters read the
 * answers, never give them.
 */
export function awaitsMainPresenterAnswer(
  amendment: Parameters<typeof authorsApproval>[0] & {
    status: AmendmentStatus;
    admission: AdmissionStatus;
    validatedAt: Date | null;
    publishedAt: Date | null;
    approvalMethod: ApprovalMethod | null;
    position: { position: ProponentPosition } | null;
  },
  document: {
    proponentMemberId: string | null;
    proponentKind: string | null;
    finalVoteId: string | null;
    acceptedAmendments: AcceptedAmendmentRule;
  },
  memberId: string,
): boolean {
  return (
    document.proponentMemberId === memberId &&
    document.finalVoteId === null &&
    countPositionsPending(
      [
        {
          status: amendment.status,
          admission: amendment.admission,
          validatedAt: amendment.validatedAt,
          publishedAt: amendment.publishedAt,
          approvalMethod: amendment.approvalMethod,
          authorsApproval: authorsApproval(amendment),
          presenterSeesValidated: document.proponentKind === "executive",
          position: amendment.position?.position ?? null,
        },
      ],
      document.acceptedAmendments,
    ) === 1
  );
}

/**
 * What groups a presenter's row with others (groupNewsRuns), or null for a
 * row that stays alone: its kind (a new amendment, whatever event made it
 * new, or the closure with its value, since a grouped sentence names the
 * transactional that replaced them), the document and whether it is about
 * transactionals. The Mesa's rows (`mesa`) group apart, by their kind, and
 * a validation also by the admission it left (newsValue), so a late one,
 * which still waits for the assembly, never folds into on-time ones; a
 * party's rejection names the party, so it stays alone.
 */
export function newsRunKey(row: {
  type: string;
  payload: Record<string, unknown>;
  presenter: boolean;
  mesa?: MesaNewsKind | null;
  documentId: string;
  transactional: boolean;
}): string | null {
  const kind = row.transactional ? "t" : "a";
  if (row.mesa) {
    if (row.mesa === "rejected") return null;
    const value =
      row.mesa === "validated" ? (newsValue(row.type, row.payload) ?? "") : "";
    return ["mesa", row.mesa, value, row.documentId, kind].join("|");
  }
  if (!row.presenter) return null;
  const what = isArrival(row.type)
    ? "arrival"
    : `${row.type}:${newsValue(row.type, row.payload) ?? ""}`;
  return [what, row.documentId, kind].join("|");
}

/**
 * Rows (newest first) in runs: a row joins the latest group of its key
 * when it came at most NEWS_RUN_MS before that group's oldest row; rows
 * with no key stay alone. Groups come in the order of their newest row.
 */
export function groupNewsRuns<T extends { createdAt: Date }>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
): T[][] {
  const groups: T[][] = [];
  const open = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = key === null ? undefined : open.get(key);
    const oldest = group?.[group.length - 1];
    if (
      group &&
      oldest &&
      oldest.createdAt.getTime() - row.createdAt.getTime() <= NEWS_RUN_MS
    ) {
      group.push(row);
      continue;
    }
    const fresh = [row];
    if (key !== null) open.set(key, fresh);
    groups.push(fresh);
  }
  return groups;
}

/**
 * The candidates of the queries in one list, newest first, each event
 * once: an event may be in several (a transactional over the member's own
 * amendment, to a document it presents). A query that filled its `limit`
 * may have left out older events, so nothing older than its oldest row is
 * kept from the others either: the list never skips a stretch of the
 * member's news. A query with `cutsOthers: false` (the Mesa's) cuts only
 * itself: what it left out is its own older events, and the other
 * queries' older rows stay.
 */
export function mergeNewsRows<T extends { id: string; createdAt: Date }>(
  ...queries: { rows: readonly T[]; limit: number; cutsOthers?: boolean }[]
): T[] {
  const byId = new Map<string, T>();
  let since = Number.NEGATIVE_INFINITY;
  for (const { rows, limit, cutsOthers = true } of queries) {
    for (const row of rows) byId.set(row.id, row);
    const oldest = rows[rows.length - 1];
    if (cutsOthers && rows.length >= limit && oldest) {
      since = Math.max(since, oldest.createdAt.getTime());
    }
  }
  return [...byId.values()]
    .filter((row) => row.createdAt.getTime() >= since)
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
}

/**
 * The decision in short (MeWorkNewsDto.value): the position, the answer to a
 * transactional, the admission a validation left, "review" for an amendment
 * the Secretaría did not admit while reviewing it, how an amendment was
 * approved, the code of the transactional that replaced it (or that
 * replaced first what a lapsed transactional grouped), the code of the
 * amendment whose fate closed a transactional, "replaced" for a
 * transactional withdrawn or lapsed after it replaced what it groups
 * (isReplacingClosure), the result of a document's final vote, the
 * status a document moved to or why a signed acta lost its signature.
 * Null when the type says it all.
 */
export function newsValue(
  type: string,
  payload: Record<string, unknown>,
): string | null {
  switch (type) {
    case "position_changed":
      return text(payload.position);
    case "acceptance_recorded":
      return text(payload.decision);
    case "amendment_validated":
      return text(payload.admission);
    case "amendment_reclassified":
      return text(payload.to);
    case "amendment_authors_changed":
      return text(payload.code);
    case "amendment_approved":
      return text(payload.method);
    case "amendment_rejected":
      // A formal one its main presenter rejected (positionEffect "reject").
      return payload.byPosition === true ? "proponent" : null;
    case "amendment_inadmissible":
      // The Secretaría's no while reviewing it: it cannot be corrected.
      return payload.onReview === true ? "review" : null;
    case "amendment_transacted":
      return text(payload.code);
    case "amendment_lapsed":
      // Named after the transactional that replaced its parents; one the
      // Mesa lapsed once in force, after it replaced them, is "replaced";
      // one that lapsed because its late parent was not admitted reads
      // plain.
      if (payload.reason === "sources_transacted") return text(payload.code);
      return isReplacingClosure(type, payload) ? "replaced" : null;
    case "transactional_source_dropped":
      return text(payload.sourceCode);
    case "amendment_withdrawn":
      if (payload.by === "sources_closed") return text(payload.sourceCode);
      return isReplacingClosure(type, payload) ? "replaced" : null;
    case "amendment_reopened":
      return payload.reason === "source_reopened"
        ? text(payload.sourceCode)
        : null;
    case "document_voted":
      // Approved leaving passages pending conciliation (user's decisions
      // of 2026-11-21): never news of a final text.
      return payload.result === "approved" &&
        Array.isArray(payload.pendingPassageKeys) &&
        payload.pendingPassageKeys.length > 0
        ? "approved_pending"
        : text(payload.result);
    case "document_status_changed":
      return text(payload.to);
    case NEWS_SIGNATURE_VOIDED:
      // Why the signature went: form_correction, final_vote_annulled or
      // unanimity_changed (SignatureVoidReason).
      return text(payload.reason);
    default:
      return null;
  }
}

/**
 * Who decided (MeWorkNewsDto.by):
 * - nobody for a transactional that closed or came back by itself
 *   (isAutomaticChange): whoever settled or reopened what it grouped did
 *   not decide about it;
 * - nobody for the automatic answer to a formal amendment
 *   (isAutomaticAnswer);
 * - the party that answered a transactional (payload.memberId);
 * - the presenter (main or co-presenter) whose answer it is, for an answer
 *   to an amendment, for the amendment its acceptance incorporated
 *   (amendment_approved with method "proponent") and for one a new answer
 *   took out again (amendment_reopened with reason "position_changed"),
 *   also when the Mesa recorded it (for the main presenter):
 *   payload.memberId, or the document's current main presenter
 *   (`mainPresenterId`) for events recorded before it was named;
 * - otherwise the member the actor acted for.
 */
export function newsByMemberId(
  type: string,
  payload: Record<string, unknown>,
  actorMemberId: string | null,
  mainPresenterId: string | null = null,
): string | null {
  if (isAutomaticChange(type, payload)) return null;
  if (isAutomaticAnswer(type, payload)) return null;
  if (type === "acceptance_recorded") return text(payload.memberId);
  if (type === "position_changed") {
    const memberId = text(payload.memberId);
    if (memberId) return memberId;
    return payload.by === "moderator" ? mainPresenterId : actorMemberId;
  }
  if (type === "amendment_approved" && payload.method === "proponent") {
    return text(payload.memberId) ?? mainPresenterId;
  }
  if (type === "amendment_reopened" && payload.reason === "position_changed") {
    return text(payload.memberId) ?? mainPresenterId;
  }
  return actorMemberId;
}

/** An assembly the home page covers, with what news visibility needs. */
export interface NewsAssembly {
  ref: MeWorkAssemblyRef;
  settings: AssemblySettings;
  status: AssemblyStatus;
}

/**
 * Whether an event is someone else's decision: not taken by this user, nor
 * for this member (its other accounts, or the Mesa recording its answer as
 * main presenter or as a party). `mainPresenterId` is the main presenter of
 * the event's document (newsByMemberId). A transactional that closed or
 * came back by itself (isAutomaticChange) is nobody's decision, so it
 * always counts, also for the user whose act on what it grouped did it. So does what an
 * Admin did while acting as this very account (`impersonationId` set): the
 * account did not decide it. Done as another account of the member, it
 * stays that member's own decision.
 */
export function isOthersDecision(
  event: {
    type: string;
    payload: Record<string, unknown>;
    actorUserId: string | null;
    actorMemberId: string | null;
    /** events.impersonation_id: an Admin did it while acting as actorUserId. */
    impersonationId?: string | null;
  },
  actor: { userId: string; memberId: string },
  mainPresenterId: string | null = null,
): boolean {
  if (isAutomaticChange(event.type, event.payload)) return true;
  if (isAutomaticAnswer(event.type, event.payload)) return true;
  if (event.actorUserId === actor.userId) return Boolean(event.impersonationId);
  return (
    newsByMemberId(
      event.type,
      event.payload,
      event.actorMemberId,
      mainPresenterId,
    ) !== actor.memberId
  );
}

/**
 * When a news row became readable to its reader, if later than when it was
 * recorded: an answer to an amendment the reader wrote, recorded while the
 * document's answers were not public to it (canSeePositions), reaches it
 * when they become public (positionsPublicSince), so it is new from then
 * on (MeWorkNewsDto.visibleAt). Null when it was readable from the start.
 */
export function newsVisibleAt(
  row: { type: string; createdAt: Date },
  document: PositionsPublication,
  seesUnpublished: boolean,
): Date | null {
  if (row.type !== "position_changed" || seesUnpublished) return null;
  const since = positionsPublicSince(document);
  return since !== null && since.getTime() > row.createdAt.getTime()
    ? since
    : null;
}

/** What loadWorkNews reads for the notices (MeNoticesDto). */
export interface WorkNews {
  /** Newest first. */
  news: MeWorkNewsDto[];
  /**
   * The documents a notice may come from: the ones the member presents
   * (main or co-presenter) and those of the amendments it wrote. The
   * amendments it answers as a presenter, and the transactionals over its
   * own, are on those same documents. For an account with the signers'
   * scope (signingNewsScope), also every document with a signing: the
   * only ones whose signature can be taken away, and where the new
   * signature that ends the notice comes from.
   */
  watchDocumentIds: string[];
  /**
   * The assemblies where any amendment may bring a notice: every one read,
   * for an account with the Mesa's scope (mesaNewsScope); none otherwise.
   */
  watchAssemblyIds: string[];
}

/**
 * The member's scopes (NewsScope) over these assemblies: the documents it
 * presents, the amendments to them, the amendments it wrote and the
 * transactionals over those.
 */
async function readMemberScope(memberId: string, inAssemblies: SQL) {
  const [presented, answered, authored, overOwn] = await Promise.all([
    // Documents the member presents, as main presenter or co-presenter.
    db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          inAssemblies,
          or(
            eq(documents.proponentMemberId, memberId),
            coPresentedBy(memberId),
          ),
        ),
      ),
    // Amendments to documents the member presents, as main presenter or
    // co-presenter: whichever of them answers, the others are told.
    db
      .select({ id: amendments.id, kind: amendments.kind })
      .from(amendments)
      .innerJoin(documents, eq(documents.id, amendments.documentId))
      .where(
        and(
          inAssemblies,
          or(
            eq(documents.proponentMemberId, memberId),
            coPresentedBy(memberId),
          ),
        ),
      ),
    // Amendments the member wrote (main author or co-author).
    db
      .select({ id: amendments.id, documentId: amendments.documentId })
      .from(amendmentAuthors)
      .innerJoin(amendments, eq(amendments.id, amendmentAuthors.amendmentId))
      .innerJoin(documents, eq(documents.id, amendments.documentId))
      .where(and(inAssemblies, eq(amendmentAuthors.memberId, memberId))),
    // Transactionals over amendments the member wrote.
    db
      .selectDistinct({
        id: amendmentSources.transactionalId,
        sourceId: amendmentSources.sourceId,
      })
      .from(amendmentSources)
      .innerJoin(
        amendmentAuthors,
        eq(amendmentAuthors.amendmentId, amendmentSources.sourceId),
      )
      .innerJoin(amendments, eq(amendments.id, amendmentSources.sourceId))
      .innerJoin(documents, eq(documents.id, amendments.documentId))
      .where(and(inAssemblies, eq(amendmentAuthors.memberId, memberId))),
  ]);
  return { presented, answered, authored, overOwn };
}

/**
 * The documents of these assemblies with a signing (agreement_record_signings):
 * the only ones whose signature can be taken away. Its row stays, emptied,
 * once that happens (clearSigning), so the document stays watched until it
 * is signed again.
 */
async function readSigningDocumentIds(inAssemblies: SQL): Promise<string[]> {
  const rows = await db
    .select({ id: agreementRecordSignings.documentId })
    .from(agreementRecordSignings)
    .innerJoin(documents, eq(documents.id, agreementRecordSignings.documentId))
    .where(inAssemblies);
  return rows.map((row) => row.id);
}

type MemberScopeRows = Awaited<ReturnType<typeof readMemberScope>>;

/** No member: none of the member's scopes. */
const NO_MEMBER_SCOPE: MemberScopeRows = {
  presented: [],
  answered: [],
  authored: [],
  overOwn: [],
};

/**
 * The news of the actor over these assemblies (the ones the home page
 * covers): its member's, and the Mesa's for an account that moderates
 * (mesaNewsScope), with or without a member, merged without repeats: an
 * event the member's scopes tell is told that way ("tu enmienda"), and
 * a validation the member is told as a presenter or an author is not told
 * again as the Mesa's (mesaRowRepeatsMember). Also the documents and
 * assemblies they come from, read with the same queries.
 */
export async function loadWorkNews(
  actor: Actor,
  newsAssemblies: NewsAssembly[],
  now: Date,
): Promise<WorkNews> {
  const memberId = actor.memberId;
  const mesa = mesaNewsScope(actor);
  const signing = signingNewsScope(actor);
  if ((!memberId && !mesa && !signing) || newsAssemblies.length === 0) {
    return { news: [], watchDocumentIds: [], watchAssemblyIds: [] };
  }
  const assemblyIds = newsAssemblies.map((assembly) => assembly.ref.id);
  const assemblyById = new Map(
    newsAssemblies.map((assembly) => [assembly.ref.id, assembly]),
  );
  const inAssemblies = inArray(documents.assemblyId, assemblyIds);
  const watchAssemblyIds = mesa ? assemblyIds : [];

  const [{ presented, answered, authored, overOwn }, signingDocumentIds] =
    await Promise.all([
      memberId ? readMemberScope(memberId, inAssemblies) : NO_MEMBER_SCOPE,
      signing ? readSigningDocumentIds(inAssemblies) : [],
    ]);
  const presentedIds = new Set(presented.map((row) => row.id));
  const answeredIds = new Set(answered.map((row) => row.id));
  const authoredIds = new Set(authored.map((row) => row.id));
  const overOwnIds = new Set(overOwn.map((row) => row.id));
  const watchDocumentIds = [
    ...new Set([
      ...presentedIds,
      ...authored.map((row) => row.documentId),
      ...signingDocumentIds,
    ]),
  ];
  const none: WorkNews = { news: [], watchDocumentIds, watchAssemblyIds };
  // The member's amendments each of those transactionals groups.
  const ownSourcesOf = new Map<string, string[]>();
  for (const row of overOwn) {
    ownSourcesOf.set(row.id, [
      ...(ownSourcesOf.get(row.id) ?? []),
      row.sourceId,
    ]);
  }

  // Broad scopes for the queries; isNewsEvent decides on each row.
  const onAmendments = eq(events.entityType, "amendment");
  const scopes: SQL[] = [];
  const positionIds = [...new Set([...answeredIds, ...authoredIds])];
  if (positionIds.length > 0) {
    scopes.push(
      and(
        onAmendments,
        eq(events.type, "position_changed"),
        inArray(events.entityId, positionIds),
      )!,
    );
  }
  const acceptanceIds = [...new Set([...overOwnIds, ...authoredIds])];
  if (acceptanceIds.length > 0) {
    scopes.push(
      and(
        onAmendments,
        eq(events.type, "acceptance_recorded"),
        inArray(events.entityId, acceptanceIds),
      )!,
    );
  }
  if (authoredIds.size > 0) {
    scopes.push(
      and(
        onAmendments,
        inArray(events.type, [...NEWS_OUTCOME_TYPES]),
        inArray(events.entityId, [...authoredIds]),
      )!,
    );
  }
  if (overOwnIds.size > 0) {
    scopes.push(
      and(
        onAmendments,
        inArray(events.type, [...AUTOMATIC_TYPES]),
        inArray(events.entityId, [...overOwnIds]),
      )!,
    );
  }
  if (presentedIds.size > 0) {
    scopes.push(
      and(
        eq(events.entityType, "document"),
        inArray(events.type, [...NEWS_DOCUMENT_TYPES]),
        inArray(events.entityId, [...presentedIds]),
      )!,
    );
  }
  // The presenters' scope over the amendments they did not write, read
  // apart with its own room (NEWS_PRESENTER_CANDIDATES), and only the
  // arrival each can have for this reader (isPresenterCandidate).
  const readsOthersValidated = seesOthersValidatedAmendments(actor);
  const presenterRows = answered.filter((row) => !authoredIds.has(row.id));
  const readsValidated = (row: { kind: string }) =>
    readsOthersValidated || row.kind === "transactional";
  const presenterScopes = [
    presenterCandidatesWhere(
      presenterRows.filter(readsValidated).map((row) => row.id),
      true,
    ),
    presenterCandidatesWhere(
      presenterRows.filter((row) => !readsValidated(row)).map((row) => row.id),
      false,
    ),
  ].filter((scope): scope is SQL => scope !== undefined);
  if (
    scopes.length === 0 &&
    presenterScopes.length === 0 &&
    !mesa &&
    !signing
  ) {
    return none;
  }

  // `ownActs`: the account's own acts are read too (the signers' scope).
  const readEvents = (scope: SQL, limit: number, ownActs = false) =>
    db
      .select({
        id: events.id,
        assemblyId: events.assemblyId,
        entityType: events.entityType,
        entityId: events.entityId,
        type: events.type,
        payload: events.payload,
        actorUserId: events.actorUserId,
        actorMemberId: events.actorMemberId,
        impersonationId: events.impersonationId,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(
        and(
          inArray(events.assemblyId, assemblyIds),
          gte(
            events.createdAt,
            new Date(now.getTime() - NEWS_WINDOW_DAYS * DAY),
          ),
          scope,
          ownActs ? undefined : notOwnDecision(actor.user.id),
        ),
      )
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(limit);
  // The Mesa's scope over the assembly's amendments, read apart with its
  // own room (NEWS_MESA_CANDIDATES), so a deadline's validations never
  // push the member's news out of a shared one, nor out of the merge. The
  // signers' scope likewise, with the account's own acts.
  const [general, presenter, mesaEvents, signingEvents] = await Promise.all([
    scopes.length > 0 ? readEvents(or(...scopes)!, NEWS_CANDIDATES) : [],
    presenterScopes.length > 0
      ? readEvents(or(...presenterScopes)!, NEWS_PRESENTER_CANDIDATES)
      : [],
    mesa ? readEvents(mesaCandidatesWhere(mesa), NEWS_MESA_CANDIDATES) : [],
    signing
      ? readEvents(signingCandidatesWhere(), NEWS_SIGNING_CANDIDATES, true)
      : [],
  ]);
  const candidates = mergeNewsRows(
    { rows: general, limit: NEWS_CANDIDATES },
    { rows: presenter, limit: NEWS_PRESENTER_CANDIDATES },
    { rows: mesaEvents, limit: NEWS_MESA_CANDIDATES, cutsOthers: false },
    { rows: signingEvents, limit: NEWS_SIGNING_CANDIDATES, cutsOthers: false },
  ).flatMap((row) => {
    const scope: NewsScope = {
      presented: presentedIds.has(row.entityId),
      answered: answeredIds.has(row.entityId),
      authored: authoredIds.has(row.entityId),
      overOwn: overOwnIds.has(row.entityId),
      ownSourceIds: ownSourcesOf.get(row.entityId) ?? [],
    };
    const role = newsRowRole(row, scope, mesa, { answeredIds, authoredIds });
    if (role) return [{ ...row, ...role, signing: false }];
    return isSigningNews(row, signing)
      ? [{ ...row, presenter: false, mesa: null, signing: true }]
      : [];
  });
  if (candidates.length === 0) return none;

  const isDocumentNews = (row: { entityType: string }) =>
    row.entityType === "document";
  // The inclusions the Mesa's `revision_ready` rows name, read only when
  // there are some: such a row stands while its inclusion waits for the
  // Secretaría (mesaNewsStands).
  const revisionIds = [
    ...new Set(
      candidates
        .filter((row) => row.mesa === "revision_ready")
        .map((row) => text(row.payload.revisionId))
        .filter((id): id is string => id !== null),
    ),
  ];
  // The signings of the signers' rows' documents, read only when there are
  // some: such a row stands while the document is not signed again
  // (signatureVoidStands).
  const signingIds = [
    ...new Set(
      candidates.filter((row) => row.signing).map((row) => row.entityId),
    ),
  ];
  const [amendmentRows, revisionRows, signedRows] = await Promise.all([
    findAmendmentsByIds([
      ...new Set(
        candidates
          .filter((row) => !isDocumentNews(row))
          .map((row) => row.entityId),
      ),
    ]),
    revisionIds.length > 0
      ? db
          .select({
            id: transactionalRevisions.id,
            status: transactionalRevisions.status,
          })
          .from(transactionalRevisions)
          .where(inArray(transactionalRevisions.id, revisionIds))
      : [],
    signingIds.length > 0
      ? db
          .select({
            documentId: agreementRecordSignings.documentId,
            url: agreementRecordSignings.signedFileUrl,
            signedAt: agreementRecordSignings.signedAt,
            versionId: agreementRecordSignings.signedVersionId,
          })
          .from(agreementRecordSignings)
          .where(inArray(agreementRecordSignings.documentId, signingIds))
      : [],
  ]);
  const signedById = new Map(signedRows.map((row) => [row.documentId, row]));
  const revisionStatusById = new Map<string, string>(
    revisionRows.map((row) => [row.id, row.status]),
  );
  const amendmentById = new Map(amendmentRows.map((row) => [row.id, row]));
  const documentRows = await withCoProponentIds(
    await db
      .select({
        id: documents.id,
        slug: documents.slug,
        title: documents.title,
        status: documents.status,
        proponentMemberId: documents.proponentMemberId,
        submittedByUserId: documents.submittedByUserId,
        positionsPublishedAt: documents.positionsPublishedAt,
        positionsDebateStartedAt: documents.positionsDebateStartedAt,
        acceptedAmendments: documents.acceptedAmendments,
        finalVoteId: documents.finalVoteId,
        // The text in force a signature must sign (signatureVoidStands),
        // and whether it is the acta de acuerdos, signed on its own page.
        consolidatedVersionId: documents.consolidatedVersionId,
        generated: documents.generated,
        // An office of the CEA answers once validated (positionBlocker).
        proponentKind: members.kind,
      })
      .from(documents)
      .leftJoin(members, eq(members.id, documents.proponentMemberId))
      .where(
        inArray(documents.id, [
          ...new Set([
            ...amendmentRows.map((row) => row.documentId),
            ...candidates.filter(isDocumentNews).map((row) => row.entityId),
          ]),
        ]),
      ),
  );
  const documentById = new Map(documentRows.map((row) => [row.id, row]));
  const documentOf = (row: { entityType: string; entityId: string }) => {
    if (isDocumentNews(row)) return documentById.get(row.entityId);
    const amendment = amendmentById.get(row.entityId);
    return amendment ? documentById.get(amendment.documentId) : undefined;
  };

  const visible = candidates.filter((row) => {
    const document = documentOf(row);
    if (document === undefined || !canSeeDocument(actor, document)) {
      return false;
    }
    if (row.signing) {
      // The signers' rows: an acta to sign again is a pending task, not
      // news of someone else's act, so it is told also when the reader's
      // own account took the signature away (its correction of form or
      // vote change), until the acta is signed for its text in force.
      return (
        assemblyById.has(row.assemblyId) &&
        signatureVoidStands(document, signedById.get(row.entityId))
      );
    }
    if (row.mesa !== null) {
      // The Mesa's rows: someone else's act on an amendment the reader
      // sees, that still stands.
      const amendment = amendmentById.get(row.entityId);
      return (
        amendment !== undefined &&
        assemblyById.has(row.assemblyId) &&
        isMesaOthersAct(row, { userId: actor.user.id, memberId }) &&
        canSeeLoadedAmendment(actor, amendment, document) &&
        mesaNewsStands(
          row.mesa,
          row,
          amendment,
          revisionStatusById.get(text(row.payload.revisionId) ?? ""),
        )
      );
    }
    // Credits the main presenter of the event's document (newsByMemberId).
    if (
      !memberId ||
      !isOthersDecision(
        row,
        { userId: actor.user.id, memberId },
        document.proponentMemberId,
      )
    ) {
      return false;
    }
    if (isDocumentNews(row)) return true;
    const amendment = amendmentById.get(row.entityId);
    const assembly = assemblyById.get(row.assemblyId);
    if (
      amendment === undefined ||
      assembly === undefined ||
      !canSeeLoadedAmendment(actor, amendment, document)
    ) {
      return false;
    }
    if (row.presenter) {
      // Only what the reader could read then, a publication it was not
      // told at validation, and never a transactional the document's
      // presenters proposed themselves.
      return (
        !(
          isArrival(row.type) &&
          isPresentersOwnTransactional(amendment, document)
        ) &&
        presenterClosureStands(row.type, amendment.status) &&
        canSeeLoadedAmendment(
          actor,
          {
            ...amendment,
            ...presenterNewsState(
              row.type,
              row.payload,
              amendment,
              row.createdAt,
            ),
          },
          document,
        ) &&
        !isRepeatedArrival(row.type, amendment, row.createdAt, (state) =>
          canSeeLoadedAmendment(actor, { ...amendment, ...state }, document),
        )
      );
    }
    // The presenters always see the answers; the authors once the
    // document's answers are public.
    return (
      row.type !== "position_changed" ||
      canSeePositions(actor, {
        document,
        isPresenter: isDocumentPresenter(actor, document),
      })
    );
  });

  // One row per new amendment and per kind of the Mesa's, then the
  // presenters' and the Mesa's runs grouped, before the cut: a group
  // counts as one row.
  const groups = groupNewsRuns(
    signingRowsOnce(mesaRowsOnce(presenterRowsOnce(visible))),
    (row) => {
      const amendment = isDocumentNews(row)
        ? undefined
        : amendmentById.get(row.entityId);
      return amendment
        ? newsRunKey({
            ...row,
            documentId: amendment.documentId,
            transactional: amendment.kind === "transactional",
          })
        : null;
    },
  ).slice(0, NEWS_LIMIT);
  const single = groups
    .filter((group) => group.length === 1)
    .map(([row]) => row!);

  // The reader is the main presenter and still has to answer it: the row
  // leads to the review.
  const awaitsAnswer = (amendment: (typeof amendmentRows)[number]) => {
    const document = documentById.get(amendment.documentId);
    return (
      memberId !== null &&
      document !== undefined &&
      awaitsMainPresenterAnswer(amendment, document, memberId)
    );
  };

  const byOf = (row: (typeof visible)[number]) =>
    newsByMemberId(
      row.type,
      row.payload,
      row.actorMemberId,
      documentOf(row)?.proponentMemberId ?? null,
    );
  // A transactional ready for the Mesa says so (`ready`), whichever
  // event made it ready.
  const valueOf = (row: (typeof visible)[number]) =>
    row.mesa === "ready" ? "ready" : newsValue(row.type, row.payload);
  const byIds = [
    ...new Set(single.map(byOf).filter((id): id is string => id !== null)),
  ];
  const memberRows =
    byIds.length > 0
      ? await db
          .select({
            id: members.id,
            acronym: members.acronym,
            name: members.name,
            kind: members.kind,
          })
          .from(members)
          .where(inArray(members.id, byIds))
      : [];
  const memberById = new Map(memberRows.map((row) => [row.id, row]));
  // An Admin's act as this very account names the Admin. News are the
  // account's own page, so only its own acts say it ("actuando como tú");
  // Admins read the rest in the activity log.
  const self = { user: actor.user, isAdmin: false };
  const impersonators = await loadImpersonators(
    single
      .filter((row) => seesImpersonator(self, row.actorUserId))
      .map((row) => row.impersonationId),
  );

  const news = groups.map((group): MeWorkNewsDto => {
    const row = group[0]!;
    const amendment = isDocumentNews(row)
      ? null
      : amendmentById.get(row.entityId)!;
    const document = documentOf(row)!;
    const base = {
      id: row.id,
      assembly: assemblyById.get(row.assemblyId)!.ref,
      document: { id: document.id, slug: document.slug, title: document.title },
      type: row.type,
      value: valueOf(row),
      at: row.createdAt.toISOString(),
    };
    if (group.length > 1) {
      // A run of the presenters' or the Mesa's rows: nobody named, the
      // first codes.
      const grouped = group
        .map((item) => amendmentById.get(item.entityId)!)
        .sort((a, b) => compareAmendmentCodes(a.code, b.code));
      return {
        ...base,
        amendment: null,
        ownAmendment: false,
        by: null,
        impersonatedBy: null,
        ...(row.mesa !== null ? { asMesa: true } : { asPresenter: true }),
        count: grouped.length,
        amendments: grouped
          .slice(0, NEWS_GROUP_CODES)
          .map((item) => ({ id: item.id, code: item.code, kind: item.kind })),
        ...(row.mesa === null && grouped.some(awaitsAnswer)
          ? { awaitsAnswer: true }
          : {}),
      };
    }
    const by = byOf(row);
    const member = by ? memberById.get(by) : undefined;
    const visibleAt = newsVisibleAt(
      row,
      document,
      seesUnpublishedPositions(actor, isDocumentPresenter(actor, document)),
    );
    return {
      ...base,
      amendment: amendment
        ? { id: amendment.id, code: amendment.code, kind: amendment.kind }
        : null,
      ownAmendment: amendment !== null && authoredIds.has(amendment.id),
      // An executive area reads as "CEA" to whoever may not see the areas.
      by: member ? redactMember(actor, toMemberRef(member)) : null,
      impersonatedBy: impersonatedByFor(self, row, impersonators),
      ...(isAutomaticAnswer(row.type, row.payload) ? { automatic: true } : {}),
      ...(row.presenter ? { asPresenter: true } : {}),
      ...(row.mesa !== null ? { asMesa: true } : {}),
      ...(row.signing && document.generated === "agreements_record"
        ? { agreementsRecord: true }
        : {}),
      ...(row.presenter && amendment && awaitsAnswer(amendment)
        ? { awaitsAnswer: true }
        : {}),
      ...(visibleAt ? { visibleAt: visibleAt.toISOString() } : {}),
    };
  });
  return { news, watchDocumentIds, watchAssemblyIds };
}

/**
 * Not this user's own decisions (isOthersDecision checks the rest), except
 * a transactional that closed by itself: its act on what that
 * transactional grouped closed it, but nobody decided it. Nor what an
 * Admin did while acting as this account: the user did not. One condition
 * for every query of loadWorkNews.
 */
function notOwnDecision(userId: string): SQL {
  return or(
    isNull(events.actorUserId),
    ne(events.actorUserId, userId),
    isNotNull(events.impersonationId),
    and(
      eq(events.type, "amendment_withdrawn"),
      sql`${events.payload}->>'by' = 'sources_closed'`,
    ),
    and(
      eq(events.type, "amendment_lapsed"),
      sql`${events.payload}->>'reason' in ('sources_transacted', 'sources_inadmissible')`,
    ),
    eq(events.type, "transactional_source_dropped"),
    and(
      eq(events.type, "amendment_reopened"),
      sql`${events.payload}->>'reason' = 'source_reopened'`,
    ),
    // Nor the automatic answer to a formal amendment (isAutomaticAnswer).
    sql`${events.payload}->>'by' = 'auto'`,
    and(
      eq(events.type, "amendment_approved"),
      sql`${events.payload}->>'reason' = 'formal'`,
    ),
  )!;
}

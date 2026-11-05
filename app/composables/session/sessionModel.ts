/**
 * Pure helpers of the Mesa session console and the projection screen. No Vue
 * or Nuxt here: everything takes DTOs and returns plain data, so the console
 * composable and the components stay thin.
 */
import type {
  AgendaItemDto,
  AmendmentDto,
  ApprovalWarnings,
  DocumentSummaryDto,
  MemberRef,
  RelationDto,
  SpeakingTurnDto,
  VoteInput,
} from "~~/shared/types/api";
import type {
  AmendmentInput,
  AmendmentOp,
  Block,
  ConsolidationResult,
} from "~~/shared/types/content";
import type {
  AcceptedAmendmentRule,
  AmendmentStatus,
  AssemblySettings,
  Majority,
} from "~~/shared/constants/domain";
import { amendmentAcceptBlocked } from "~/composables/amendment/workspace";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { touchedBlockIds } from "~~/shared/utils/content/ops";
import {
  findOverlaps,
  isHardOverlap,
  overlapBetween,
} from "~~/shared/utils/content/overlaps";
import { computeVoteOutcome, type VoteOutcome } from "~~/shared/utils/votes";

// Errors ---------------------------------------------------------------------

/**
 * The `data` an API error carried (`createError({ data })`). ofetch exposes
 * the response body as `error.data`, and h3 nests the handler's data inside
 * it, so `{ conflicts }`, `{ undecided }` or `{ tie }` live at `error.data.data`.
 */
export function sessionErrorData(
  error: unknown,
): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { data?: unknown }).data;
  if (!body || typeof body !== "object") return null;
  const inner = (body as { data?: unknown }).data;
  return inner && typeof inner === "object"
    ? (inner as Record<string, unknown>)
    : null;
}

/** String ids found under `key` of an error's data, e.g. `undecided`. */
export function sessionErrorIds(error: unknown, key: string): string[] {
  const value = sessionErrorData(error)?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// Amendment state ------------------------------------------------------------

/** Statuses an amendment can be reopened from (see the outcome endpoint). */
export const SESSION_REOPENABLE: AmendmentStatus[] = [
  "approved",
  "rejected",
  "withdrawn",
  "lapsed",
];

/**
 * Whether the outcome endpoint would reopen it: a status it reopens from
 * and, for a transactional, not turned down by a main author and either
 * one that replaced its sources (they stay replaced) or one whose loaded
 * sources are all still open. One that another transactional got ahead of
 * (it lapsed when the other replaced them) would come back stuck.
 */
export function isSessionReopenable(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): boolean {
  if (!SESSION_REOPENABLE.includes(amendment.status)) return false;
  if (amendment.kind !== "transactional") return true;
  if (sessionTransactionalRejectors(amendment).length > 0) return false;
  if (isSessionReplacing(amendment)) return true;
  return amendment.sourceIds.every((id) => {
    const source = byId.get(id);
    return source === undefined || source.status === "submitted";
  });
}

// Validation by the Secretaría ------------------------------------------------

/**
 * A transactional proposed by a member, waiting for the main author of each
 * amendment it would replace to accept it before the Secretaría checks it.
 * Draft or presented, it is not the Mesa's yet.
 */
export function isSessionAwaitingAuthors(amendment: AmendmentDto): boolean {
  return (
    amendment.reviewState === "pending_authors" &&
    (amendment.status === "submitted" || amendment.status === "draft")
  );
}

/**
 * The main author of an amendment: the one that answers the transactionals
 * proposed over it. `mainAuthorId` names it; without it the first author
 * (authors come main author first) is taken.
 */
export function sessionMainAuthor(amendment: AmendmentDto): MemberRef | null {
  if (amendment.mainAuthorId) {
    const named = amendment.authors.find(
      (author) => author.id === amendment.mainAuthorId,
    );
    if (named) return named;
  }
  return amendment.authors[0] ?? null;
}

/**
 * The parties that turned a transactional down. Any main author saying no
 * closes it and the amendments it would have replaced carry on, whatever
 * status the server records for it. Empty for anything else.
 */
export function sessionTransactionalRejectors(
  amendment: AmendmentDto,
): MemberRef[] {
  if (amendment.kind !== "transactional") return [];
  return amendment.acceptances
    .filter((party) => party.decision === "rejected")
    .map((party) => party.member);
}

/**
 * Approved because the document's main presenter accepted it, without a
 * vote: the document incorporates accepted amendments (regulations by
 * default). If the presenter changes its answer before the final vote, it
 * goes back to undecided.
 */
export function isSessionIncorporated(amendment: AmendmentDto): boolean {
  return (
    amendment.status === "approved" && amendment.approvalMethod === "proponent"
  );
}

/**
 * A transactional that replaced the amendments it groups at some point:
 * validated by the Secretaría (the Mesa's are at once) and accepted by every
 * main author, the moment the server turns its sources `transacted`, or
 * approved (one presented under the earlier rule replaced them then). From
 * then on the answers of its main authors are final, and its sources stay
 * replaced whatever happens to it later (voted down, withdrawn, lapsed or
 * replaced in turn).
 */
export function isSessionReplacing(amendment: AmendmentDto): boolean {
  if (amendment.kind !== "transactional" || amendment.status === "draft") {
    return false;
  }
  if (amendment.status === "approved") return true;
  return (
    amendment.validatedAt !== null &&
    amendment.acceptances.every((party) => party.decision === "accepted")
  );
}

/**
 * The amendments whose settling closed a transactional on its own: one still
 * waiting (it never replaced what it groups, and no main author turned it
 * down) is withdrawn by the server in the same moment one of the amendments
 * it groups is decided, withdrawn, lapsed, declared inadmissible or
 * incorporated (one left behind because another transactional replaced them
 * first lapses instead). That moment tells it apart from one withdrawn by
 * whoever proposed it or by the Mesa: it was closed at the very instant a
 * loaded source stopped being open. Empty for anything else. The DTO does
 * not say why it was withdrawn, so should that amendment be reopened and
 * settled again later, the instants no longer match and it reads as an
 * ordinary withdrawal.
 */
export function sessionClosingSourceIds(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): string[] {
  if (
    amendment.kind !== "transactional" ||
    amendment.status !== "withdrawn" ||
    sessionTransactionalRejectors(amendment).length > 0 ||
    isSessionReplacing(amendment)
  ) {
    return [];
  }
  const closedAt = instant(amendment.decidedAt);
  if (closedAt === null) return [];
  return amendment.sourceIds.filter((id) => {
    const source = byId.get(id);
    return (
      source !== undefined &&
      source.status !== "submitted" &&
      source.status !== "draft" &&
      instant(source.decidedAt) === closedAt
    );
  });
}

/**
 * The transactionals that got ahead of a lapsed one: it still waited (no
 * main author turned it down) when another transactional replaced some
 * amendment it groups, and the server let it lapse in that same moment
 * (the replaced amendment turned `transacted` at the very instant it
 * lapsed). Named through sessionReplacingIds of those amendments, without
 * itself. Empty for anything else, including one the Mesa declared lapsed.
 */
export function sessionLapsingTransactionalIds(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): string[] {
  if (
    amendment.kind !== "transactional" ||
    amendment.status !== "lapsed" ||
    sessionTransactionalRejectors(amendment).length > 0 ||
    isSessionReplacing(amendment)
  ) {
    return [];
  }
  const lapsedAt = instant(amendment.decidedAt);
  if (lapsedAt === null) return [];
  const ids = new Set<string>();
  for (const id of amendment.sourceIds) {
    const source = byId.get(id);
    if (
      source === undefined ||
      source.status !== "transacted" ||
      instant(source.decidedAt) !== lapsedAt
    ) {
      continue;
    }
    for (const replacing of sessionReplacingIds(source, byId)) {
      if (replacing !== amendment.id) ids.add(replacing);
    }
  }
  return [...ids];
}

/** Milliseconds of an ISO date, or null when there is none. */
function instant(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The sources a presented transactional can no longer replace: loaded ones
 * that are not open any more because another transactional replaced them
 * first or they were decided. Empty for anything else, and for one that
 * already replaced its sources or that a main author turned down.
 */
export function sessionSupersededSourceIds(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): string[] {
  if (
    amendment.kind !== "transactional" ||
    amendment.status !== "submitted" ||
    isSessionReplacing(amendment) ||
    sessionTransactionalRejectors(amendment).length > 0
  ) {
    return [];
  }
  return amendment.sourceIds.filter((id) => {
    const source = byId.get(id);
    return source !== undefined && source.status !== "submitted";
  });
}

/**
 * A presented transactional that can never go ahead: some amendment it
 * would replace is no longer open (sessionSupersededSourceIds). The server
 * refuses to validate it or to record the answer that would complete it,
 * so only withdrawing it settles it.
 */
export function isSessionSuperseded(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): boolean {
  return sessionSupersededSourceIds(amendment, byId).length > 0;
}

/**
 * The transactionals that replaced an amendment (it is `transacted`), or
 * that are proposed over it. For a replaced amendment, the loaded one that
 * did it (isSessionReplacing) wins over others built on it; without one,
 * any that no main author turned down. Otherwise, those still open
 * (presented or in draft) that no main author turned down. Unknown ids (not
 * loaded) are kept: they may be the one.
 */
export function sessionReplacingIds(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): string[] {
  const notTurnedDown = (id: string) => {
    const transactional = byId.get(id);
    return (
      !transactional ||
      sessionTransactionalRejectors(transactional).length === 0
    );
  };
  if (amendment.status === "transacted") {
    const replacing = amendment.transactionalIds.filter((id) => {
      const transactional = byId.get(id);
      return transactional !== undefined && isSessionReplacing(transactional);
    });
    return replacing.length > 0
      ? replacing
      : amendment.transactionalIds.filter(notTurnedDown);
  }
  return amendment.transactionalIds.filter((id) => {
    const transactional = byId.get(id);
    if (!transactional) return true;
    return (
      notTurnedDown(id) &&
      (transactional.status === "submitted" || transactional.status === "draft")
    );
  });
}

/**
 * The amendments a transactional replaced: its sources once it did
 * (isSessionReplacing, also after it was decided) and they are
 * `transacted`. Empty while it still waits for its main authors or the
 * Secretaría, and for one that another transactional got ahead of.
 */
export function sessionReplacedIds(
  amendment: AmendmentDto,
  byId: ReadonlyMap<string, AmendmentDto>,
): string[] {
  if (!isSessionReplacing(amendment)) return [];
  return amendment.sourceIds.filter(
    (id) => byId.get(id)?.status === "transacted",
  );
}

/**
 * Not checked by the Secretaría yet: a transactional still waiting for the
 * main authors of what it replaces, presented and waiting for validation,
 * or sent back to its authors for a correction (a draft again). The Mesa
 * cannot debate, admit or decide it until the Secretaría validates it.
 */
export function isSessionAwaitingValidation(amendment: AmendmentDto): boolean {
  return (
    isSessionAwaitingAuthors(amendment) ||
    (amendment.status === "submitted" &&
      amendment.reviewState === "pending_validation") ||
    (amendment.status === "draft" &&
      amendment.reviewState === "correction_requested")
  );
}

/**
 * Validated but not published: only its authors, the Secretaría and the
 * Mesa see it. It can be debated; the rest of the assembly cannot read it yet.
 */
export function isSessionUnpublished(amendment: AmendmentDto): boolean {
  return amendment.reviewState === "validated";
}

/** The actor may validate it now (presented, not validated yet). */
export function isSessionValidatable(amendment: AmendmentDto): boolean {
  return (
    amendment.status === "submitted" &&
    amendment.reviewState === "pending_validation" &&
    amendment.can.validate
  );
}

/** The actor may make it visible to everyone (validated, not published). */
export function isSessionPublishable(amendment: AmendmentDto): boolean {
  return isSessionUnpublished(amendment) && amendment.can.publish;
}

/**
 * Ids the actor can validate among `ids` (all of the list when omitted), in
 * text order: what a bulk "validate" sends.
 */
export function sessionValidationIds(
  list: AmendmentDto[],
  ids?: string[],
): string[] {
  const wanted = ids ? new Set(ids) : null;
  return sortSessionAmendments(list)
    .filter(
      (amendment) =>
        (!wanted || wanted.has(amendment.id)) &&
        isSessionValidatable(amendment),
    )
    .map((amendment) => amendment.id);
}

/** Submitted and admitted: the Mesa can decide it now. */
export function isSessionOpen(amendment: AmendmentDto): boolean {
  return (
    amendment.status === "submitted" &&
    amendment.admission === "admitted" &&
    !isSessionAwaitingValidation(amendment)
  );
}

/**
 * Validated, but late (or manually reviewed) and still waiting for the
 * Mesa's admission decision. Amendments the Secretaría has not validated
 * yet are never here, even though their admission is pending too.
 */
export function isSessionPendingAdmission(amendment: AmendmentDto): boolean {
  return (
    amendment.status === "submitted" &&
    amendment.admission === "pending" &&
    !isSessionAwaitingValidation(amendment)
  );
}

/** Still to be decided by the Mesa: submitted and validated. */
export function isSessionUndecided(amendment: AmendmentDto): boolean {
  return (
    amendment.status === "submitted" && !isSessionAwaitingValidation(amendment)
  );
}

export type SessionAdmissionDecision = "admitted" | "inadmissible";

/**
 * Whether the server accepts `decision` for the amendment (mirrors the
 * admission endpoint): any undecided amendment can be declared inadmissible,
 * on time or late; admitting covers late ones still pending and re-admits
 * those declared inadmissible. Nothing the Secretaría has not validated yet
 * is offered: it checks every amendment before the Mesa decides on it.
 */
export function isSessionAdmissionEligible(
  amendment: AmendmentDto,
  decision: SessionAdmissionDecision,
): boolean {
  if (isSessionAwaitingValidation(amendment)) return false;
  if (decision === "inadmissible") return amendment.status === "submitted";
  return (
    (amendment.status === "submitted" && amendment.admission !== "admitted") ||
    amendment.status === "inadmissible"
  );
}

/**
 * Amendments the admission dialog lists for `decision`, in text order: those
 * pending admission plus the ones it was opened for (an on-time amendment to
 * declare inadmissible, an inadmissible one to re-admit), keeping only those
 * the server would accept. Old inadmissions and on-time amendments are never
 * swept in by a bulk action.
 */
export function sessionAdmissionCandidates(
  list: AmendmentDto[],
  decision: SessionAdmissionDecision,
  requested: string[] = [],
): AmendmentDto[] {
  const asked = new Set(requested);
  return sortSessionAmendments(
    list.filter(
      (amendment) =>
        (isSessionPendingAdmission(amendment) || asked.has(amendment.id)) &&
        isSessionAdmissionEligible(amendment, decision),
    ),
  );
}

/** A transactional that still lacks the acceptance of some party. */
export function sessionMissingAcceptances(amendment: AmendmentDto): number {
  if (amendment.kind !== "transactional") return 0;
  return amendment.acceptances.filter((party) => party.decision !== "accepted")
    .length;
}

/**
 * Whether the Mesa may approve or vote it right now: open, accepted by
 * every party of a transactional, and public (nothing is decided that
 * delegates cannot read; the server answers 409 otherwise).
 */
export function isSessionDecidable(amendment: AmendmentDto): boolean {
  return (
    isSessionOpen(amendment) &&
    amendment.publishedAt !== null &&
    sessionMissingAcceptances(amendment) === 0
  );
}

/**
 * Whether it can be a source of a transactional now: open and public (the
 * server refuses private sources: delegates could not read what is merged)
 * and, for a transactional, accepted by every main author (until then its
 * originals are still there, and the server refuses it as a source).
 */
export function isSessionTransactable(amendment: AmendmentDto): boolean {
  return (
    isSessionOpen(amendment) &&
    amendment.publishedAt !== null &&
    sessionMissingAcceptances(amendment) === 0
  );
}

/**
 * Whether this actor can put it on the projection: only public amendments
 * are projected, so a private one needs someone who can publish it first.
 */
export function isSessionProjectable(amendment: AmendmentDto): boolean {
  return amendment.publishedAt !== null || isSessionPublishable(amendment);
}

/**
 * Whether this actor can put it under debate: the Mesa can decide it now
 * and the projection can show it (see isSessionProjectable).
 */
export function isSessionDebatable(amendment: AmendmentDto): boolean {
  return isSessionOpen(amendment) && isSessionProjectable(amendment);
}

// The main presenter's answer -------------------------------------------------

/**
 * What the console offers to record the answer of the document's main
 * presenter, which the Mesa gives for it in the room. Only published
 * amendments are answered (validated and, if late, admitted: what
 * `can.position` says), never after the final vote, and an incorporated one
 * keeps its answer open until then (changing it takes it out of the text).
 * - null: nothing to offer, now or later from here;
 * - `waitsPublication`: open to the Mesa but still private, so no answer can
 *   be recorded until the Secretaría publishes it: the console shows the
 *   answer disabled, with that reason;
 * - `acceptBlocked`: accepting is refused while it is private under the
 *   "incorporate" rule (amendmentAcceptBlocked).
 */
export interface SessionPositionMenu {
  waitsPublication: boolean;
  acceptBlocked: boolean;
}

export function sessionPositionMenu(
  amendment: AmendmentDto,
  rule: AcceptedAmendmentRule,
  voted: boolean,
): SessionPositionMenu | null {
  if (voted) return null;
  if (amendment.status !== "submitted" && !isSessionIncorporated(amendment)) {
    return null;
  }
  const acceptBlocked = amendmentAcceptBlocked(amendment, rule);
  if (amendment.publishedAt === null) {
    // Validated, admitted and accepted by every main author, only private:
    // the Mesa sees why it cannot answer it yet.
    const reached =
      isSessionOpen(amendment) && sessionMissingAcceptances(amendment) === 0;
    return reached && (amendment.can.position || amendment.can.moderate)
      ? { waitsPublication: true, acceptBlocked }
      : null;
  }
  return amendment.can.position
    ? { waitsPublication: false, acceptBlocked }
    : null;
}

/**
 * The Mesa recorded this answer for the main presenter (said as "La Mesa,
 * en nombre de UPV"). An answer set back to pending is not one: it reads as
 * the main presenter's ("Respuesta de UPV:", pending), whoever cleared it.
 */
export function isSessionPositionByMesa(
  position: AmendmentDto["position"],
): boolean {
  return (
    position !== null &&
    position.recordedBy === "mesa" &&
    position.position !== "pending"
  );
}

/** Text order (totality amendments first, as positionKey encodes), then number. */
export function sortSessionAmendments(list: AmendmentDto[]): AmendmentDto[] {
  return [...list].sort(
    (a, b) =>
      a.positionKey - b.positionKey ||
      (a.number ?? Number.MAX_SAFE_INTEGER) -
        (b.number ?? Number.MAX_SAFE_INTEGER) ||
      (a.code ?? "").localeCompare(b.code ?? "") ||
      a.id.localeCompare(b.id),
  );
}

// Queue ----------------------------------------------------------------------

export type SessionQueueEntry =
  | { type: "amendment"; amendment: AmendmentDto }
  | {
      type: "cluster";
      id: string;
      amendments: AmendmentDto[];
      /**
       * Members the Mesa can still transact: submitted, admitted and public
       * (isSessionTransactable).
       */
      openIds: string[];
    };

export interface SessionQueue {
  /**
   * Amendments the Secretaría has not validated yet (or sent back for a
   * correction), in text order. They are not part of the debate.
   */
  validation: AmendmentDto[];
  /** Late amendments waiting for an admission decision, in text order. */
  pending: AmendmentDto[];
  /** Everything else, in text order, with overlapping ones grouped. */
  entries: SessionQueueEntry[];
}

/** Amendments that take part in overlap clusters: live or already in the text. */
function clusterable(amendment: AmendmentDto): boolean {
  return (
    amendment.ops.length > 0 &&
    amendment.admission === "admitted" &&
    !isSessionAwaitingValidation(amendment) &&
    (amendment.status === "submitted" || amendment.status === "approved")
  );
}

/**
 * The console queue of a document. Drafts are left out, except those the
 * Secretaría sent back for a correction. Amendments not validated yet go to
 * their own group, outside the debate. Late amendments pending admission
 * come next; the rest follow the text, and amendments that act on the same
 * passage (findOverlaps) are grouped where the first of them appears.
 */
export function buildSessionQueue(list: AmendmentDto[]): SessionQueue {
  const sorted = sortSessionAmendments(
    list.filter(
      (amendment) =>
        amendment.status !== "draft" || isSessionAwaitingValidation(amendment),
    ),
  );
  const validation = sorted.filter(isSessionAwaitingValidation);
  const ready = sorted.filter(
    (amendment) => !isSessionAwaitingValidation(amendment),
  );
  const pending = ready.filter(isSessionPendingAdmission);
  const rest = ready.filter(
    (amendment) => !isSessionPendingAdmission(amendment),
  );

  const report = findOverlaps(
    rest
      .filter(clusterable)
      .map((amendment) => ({ id: amendment.id, ops: amendment.ops })),
  );
  const clusterOf = new Map<string, number>();
  report.clusters.forEach((cluster, index) => {
    cluster.forEach((id) => clusterOf.set(id, index));
  });

  const entries: SessionQueueEntry[] = [];
  const emitted = new Set<number>();
  for (const amendment of rest) {
    const index = clusterOf.get(amendment.id);
    if (index === undefined) {
      entries.push({ type: "amendment", amendment });
      continue;
    }
    if (emitted.has(index)) continue;
    emitted.add(index);
    const members = rest.filter((other) => clusterOf.get(other.id) === index);
    entries.push({
      type: "cluster",
      id: members[0]!.id,
      amendments: members,
      openIds: members.filter(isSessionTransactable).map((other) => other.id),
    });
  }
  return { validation, pending, entries };
}

/**
 * Figures of the debate queue: amendments the Secretaría has not validated
 * yet are counted apart, since the Mesa cannot decide them. `presented`
 * counts every one past draft, validated or not: the figure the agenda
 * shows for the document (its amendmentCount), so both say the same.
 */
export function sessionQueueCounts(list: AmendmentDto[]): {
  presented: number;
  total: number;
  undecided: number;
  approved: number;
  awaitingValidation: number;
} {
  const awaiting = list.filter(isSessionAwaitingValidation);
  const listed = list.filter(
    (amendment) =>
      amendment.status !== "draft" && !isSessionAwaitingValidation(amendment),
  );
  return {
    presented: list.filter((amendment) => amendment.status !== "draft").length,
    total: listed.length,
    undecided: listed.filter(isSessionUndecided).length,
    approved: listed.filter((amendment) => amendment.status === "approved")
      .length,
    awaitingValidation: awaiting.length,
  };
}

/**
 * Who the amendments outside the debate are waiting for: the Secretaría
 * (presented, not validated yet), their authors (sent back for a
 * correction) or the main authors of the amendments a member's
 * transactional would replace (they have to accept it first).
 */
export function sessionValidationBreakdown(list: AmendmentDto[]): {
  toValidate: number;
  inCorrection: number;
  awaitingAuthors: number;
} {
  const awaiting = list.filter(isSessionAwaitingValidation);
  const inCorrection = awaiting.filter(
    (amendment) => amendment.reviewState === "correction_requested",
  ).length;
  const awaitingAuthors = awaiting.filter(isSessionAwaitingAuthors).length;
  return {
    toValidate: awaiting.length - inCorrection - awaitingAuthors,
    inCorrection,
    awaitingAuthors,
  };
}

/**
 * A transactional that still waits for the answer of some main author:
 * proposed by a member and not passed to the Secretaría yet, or drafted by
 * the Mesa in the room and not accepted by everyone yet. One a main author
 * turned down waits for nobody.
 */
function waitsForAuthors(amendment: AmendmentDto): boolean {
  if (sessionTransactionalRejectors(amendment).length > 0) return false;
  return (
    isSessionAwaitingAuthors(amendment) ||
    (isSessionOpen(amendment) && sessionMissingAcceptances(amendment) > 0)
  );
}

/**
 * What still stops the final vote, split by who has to act, in text order.
 * The server blocks it while any amendment is submitted, validated or not:
 * - `undecided`: the Mesa decides them (or the main presenter's answer
 *   incorporates them);
 * - `superseded`: transactionals that can never go ahead because another
 *   one replaced, or a decision settled, an amendment they would replace
 *   (isSessionSuperseded): the Mesa or whoever proposed them withdraws them;
 * - `late`: presented after the deadline, the assembly has not decided
 *   whether to treat them;
 * - `awaitingAuthors`: transactionals the main authors of what they replace
 *   have not accepted yet, before the Secretaría or in the room;
 * - `awaitingValidation`: the Secretaría has to validate them or send them
 *   back to their authors.
 * `serverIds` are the ids a refused final vote reported (409
 * `{ undecided }`): they count too, unless the console already knows they
 * are decided. Ids the console has not loaded count as undecided.
 */
export function sessionFinalVoteBlockers(
  list: AmendmentDto[],
  serverIds: string[] = [],
): {
  undecided: string[];
  superseded: string[];
  late: string[];
  awaitingAuthors: string[];
  awaitingValidation: string[];
} {
  const byId = new Map(list.map((amendment) => [amendment.id, amendment]));
  const ids = sortSessionAmendments(
    list.filter((amendment) => amendment.status === "submitted"),
  ).map((amendment) => amendment.id);
  const known = new Set(ids);
  for (const id of serverIds) {
    if (known.has(id)) continue;
    const amendment = byId.get(id);
    if (amendment && amendment.status !== "submitted") continue;
    known.add(id);
    ids.push(id);
  }
  const undecided: string[] = [];
  const superseded: string[] = [];
  const late: string[] = [];
  const awaitingAuthors: string[] = [];
  const awaitingValidation: string[] = [];
  for (const id of ids) {
    const amendment = byId.get(id);
    // Unknown, or turned down by a main author yet still presented (the
    // server normally closes it): nobody but the Mesa can settle it.
    if (!amendment || sessionTransactionalRejectors(amendment).length > 0) {
      undecided.push(id);
    } else if (isSessionSuperseded(amendment, byId)) superseded.push(id);
    else if (waitsForAuthors(amendment)) awaitingAuthors.push(id);
    else if (isSessionAwaitingValidation(amendment)) {
      awaitingValidation.push(id);
    } else if (isSessionPendingAdmission(amendment)) late.push(id);
    else undecided.push(id);
  }
  return { undecided, superseded, late, awaitingAuthors, awaitingValidation };
}

export type SessionFinalVoteReason =
  | { key: "notVoted" }
  | { key: "notPublished" }
  | { key: "amendmentsLoading" }
  | { key: "totalityReturn"; id: string }
  | { key: "undecided"; count: number }
  | { key: "superseded"; count: number }
  | { key: "late"; count: number }
  | { key: "awaitingAuthors"; count: number }
  | { key: "awaitingValidation"; count: number };

/**
 * Why the final vote on a document cannot be recorded yet, one reason per
 * party that has to act. Empty when it can. Until the document's amendments
 * arrive, an empty list would read as "nothing undecided", so that is a
 * reason too. An approved totality return comes before the undecided
 * count: the text goes back and there is no final vote at all.
 */
export function sessionFinalVoteReasons(input: {
  document: { voted: boolean; status: string } | null;
  amendmentsLoaded: boolean;
  totalityReturnId: string | null;
  blockers: ReturnType<typeof sessionFinalVoteBlockers>;
}): SessionFinalVoteReason[] {
  const { document, blockers } = input;
  if (!document) return [];
  if (!document.voted) return [{ key: "notVoted" }];
  if (document.status !== "published") return [{ key: "notPublished" }];
  if (!input.amendmentsLoaded) return [{ key: "amendmentsLoading" }];
  if (input.totalityReturnId) {
    return [{ key: "totalityReturn", id: input.totalityReturnId }];
  }
  const reasons: SessionFinalVoteReason[] = [];
  for (const key of [
    "undecided",
    "superseded",
    "late",
    "awaitingAuthors",
    "awaitingValidation",
  ] as const) {
    const count = blockers[key].length;
    if (count > 0) reasons.push({ key, count });
  }
  return reasons;
}

// Debate ---------------------------------------------------------------------

/**
 * Where an amendment stands in the session, as one status the console and
 * the queue show with what happens next:
 * - `turned_down`: a transactional some main author did not accept: it is
 *   closed and the amendments it would have replaced carry on;
 * - `closed`: a transactional the server closed on its own because an
 *   amendment it groups was settled first (sessionClosingSourceIds, only
 *   known with `byId`);
 * - `superseded`: a presented transactional that can never go ahead,
 *   since an amendment it would replace is no longer open
 *   (isSessionSuperseded, only known with `byId`): it has to be withdrawn;
 * - `awaiting_authors`: a member's transactional the main authors of what
 *   it replaces have not accepted yet (before the Secretaría checks it);
 * - `awaiting_validation`: the Secretaría has not checked it;
 * - `correction_requested`: back with its authors for a correction;
 * - `late`: validated but presented after the deadline, waiting for the
 *   assembly's decision to treat it;
 * - `acceptances`: a transactional drafted in the room whose main authors
 *   have not all accepted it yet;
 * - `open`: the Mesa can decide it now;
 * - `incorporated`: approved without a vote because the document's main
 *   presenter accepted it;
 * - otherwise its final status.
 */
export type SessionAmendmentStage =
  | "turned_down"
  | "closed"
  | "superseded"
  | "awaiting_authors"
  | "awaiting_validation"
  | "correction_requested"
  | "late"
  | "acceptances"
  | "open"
  | "incorporated"
  | Exclude<AmendmentStatus, "submitted">;

export function sessionAmendmentStage(
  amendment: AmendmentDto,
  byId?: ReadonlyMap<string, AmendmentDto>,
): SessionAmendmentStage {
  if (sessionTransactionalRejectors(amendment).length > 0) {
    return "turned_down";
  }
  if (byId && sessionClosingSourceIds(amendment, byId).length > 0) {
    return "closed";
  }
  if (byId && isSessionSuperseded(amendment, byId)) return "superseded";
  if (isSessionAwaitingAuthors(amendment)) return "awaiting_authors";
  if (isSessionAwaitingValidation(amendment)) {
    return amendment.reviewState === "correction_requested"
      ? "correction_requested"
      : "awaiting_validation";
  }
  if (isSessionIncorporated(amendment)) return "incorporated";
  if (amendment.status !== "submitted") return amendment.status;
  if (amendment.admission !== "admitted") return "late";
  if (sessionMissingAcceptances(amendment) > 0) return "acceptances";
  return "open";
}

/**
 * The amendment "Siguiente" puts under debate: the first one this actor can
 * debate (validated, admitted, undecided, and public or publishable by them:
 * isSessionDebatable) after `currentId` in the order of the queue, wrapping
 * around to those skipped before it. Late amendments still waiting for the
 * assembly's decision, those not validated yet, private ones the actor
 * cannot publish, decided ones and transactionals that can no longer go
 * ahead (isSessionSuperseded) are never offered. When the current one was
 * transacted, the transactional debated in its place comes first, wherever
 * it sits in the text. Null when nothing else is left.
 */
export function sessionNextAmendmentId(
  queue: SessionQueue,
  currentId: string | null,
  debatable: (amendment: AmendmentDto) => boolean = isSessionDebatable,
): string | null {
  const byId = new Map<string, AmendmentDto>();
  for (const entry of queue.entries) {
    const members =
      entry.type === "amendment" ? [entry.amendment] : entry.amendments;
    members.forEach((amendment) => byId.set(amendment.id, amendment));
  }
  const order = sessionQueueOrder(queue).filter((id) => {
    const amendment = byId.get(id);
    return (
      amendment !== undefined &&
      debatable(amendment) &&
      !isSessionSuperseded(amendment, byId)
    );
  });
  const current = currentId ? byId.get(currentId) : undefined;
  if (current?.status === "transacted") {
    const replacing = sessionReplacingIds(current, byId).find((id) =>
      order.includes(id),
    );
    if (replacing) return replacing;
  }
  const index = currentId ? order.indexOf(currentId) : -1;
  const after = index === -1 ? order : order.slice(index + 1);
  const before = index === -1 ? [] : order.slice(0, index);
  return [...after, ...before].find((id) => id !== currentId) ?? null;
}

export interface SessionAgendaTarget {
  row: SessionAgendaRow;
  /** Its only published document, debated with the item; null otherwise. */
  document: DocumentSummaryDto | null;
}

/**
 * The agenda item after `currentId` (the first one when nothing is under
 * debate), with its document when it has exactly one published: the Mesa
 * moves to the item and its text in one step. Null after the last item.
 */
export function sessionNextAgendaTarget(
  rows: SessionAgendaRow[],
  currentId: string | null,
): SessionAgendaTarget | null {
  const index = currentId
    ? rows.findIndex((row) => row.item.id === currentId)
    : -1;
  const row = rows[index + 1];
  if (!row) return null;
  const published = row.documents.filter(
    (document) => document.status === "published",
  );
  return { row, document: published.length === 1 ? published[0]! : null };
}

// Live connection ------------------------------------------------------------

export type SessionConnection = "live" | "polling" | "connecting" | "offline";

/**
 * What the live badge says. Before the first connection is ready the
 * console is still connecting, not offline; once it has been live, losing
 * the stream reads as offline until polling takes over.
 */
export function sessionConnectionState(
  connected: boolean,
  polling: boolean,
  everConnected: boolean,
): SessionConnection {
  if (connected) return "live";
  if (polling) return "polling";
  return everConnected ? "offline" : "connecting";
}

// Speaking turns -------------------------------------------------------------

export interface SessionSpeakers {
  /** Who has the floor now. */
  speaking: SpeakingTurnDto | null;
  /** Waiting turns, in the order they will speak. */
  waiting: SpeakingTurnDto[];
  /** Turns that already spoke, latest first. */
  done: SpeakingTurnDto[];
}

function time(value: string | null): number {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The speaking turns split as the Mesa reads them. Waiting turns follow
 * their position (then the order they were written down); cancelled ones
 * are left out. Should two turns be speaking at once, the latest to start
 * has the floor.
 */
export function sessionSpeakers(turns: SpeakingTurnDto[]): SessionSpeakers {
  const waiting = turns
    .filter((turn) => turn.status === "waiting")
    .sort(
      (a, b) =>
        a.position - b.position ||
        time(a.createdAt) - time(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const speaking =
    turns
      .filter((turn) => turn.status === "speaking")
      .sort((a, b) => time(b.startedAt) - time(a.startedAt))[0] ?? null;
  const done = turns
    .filter((turn) => turn.status === "done")
    .sort(
      (a, b) =>
        time(b.endedAt) - time(a.endedAt) ||
        time(b.startedAt) - time(a.startedAt),
    );
  return { speaking, waiting, done };
}

/**
 * The place a waiting turn moves to, one step up (-1) or down (1): its
 * 0-based index among the waiting turns, which is what the console sends
 * as `position`. Null when it cannot move that way.
 */
export function sessionTurnMoveIndex(
  waiting: SpeakingTurnDto[],
  id: string,
  step: 1 | -1,
): number | null {
  const index = waiting.findIndex((turn) => turn.id === id);
  if (index === -1) return null;
  const target = index + step;
  return target >= 0 && target < waiting.length ? target : null;
}

/** Whole seconds since `startedAt`, never negative (clocks may disagree). */
export function sessionElapsedSeconds(
  startedAt: string | null,
  now: number,
): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((now - start) / 1000));
}

/** "m:ss", or "h:mm:ss" from an hour on. */
export function sessionFormatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

/**
 * Whether a live event may change the speaking turns: a turn was written
 * down, given the floor, ended, removed or moved, or who sees them changed
 * (`speakers`); the live state changed (the Mesa's list follows the agenda
 * item in debate); or the client lost track and must refetch everything
 * (`poll`).
 */
export function isSessionSpeakersEvent(event: {
  type: string;
  entityType: string;
}): boolean {
  return (
    event.type === "poll" ||
    event.entityType === "speakers" ||
    event.entityType === "live"
  );
}

/**
 * Who a turn is for, as one line for labels: the member's acronym and the
 * person's name when the Mesa wrote it ("CEUM (Ana Pérez)"), or whichever
 * of the two is there. Null when neither is.
 */
export function sessionTurnWho(turn: SpeakingTurnDto): string | null {
  const speaker = turn.speaker?.trim() || null;
  const member = turn.member?.acronym ?? null;
  if (member && speaker) return `${member} (${speaker})`;
  return member ?? speaker;
}

/** How long a finished turn lasted, in seconds; null when unknown. */
export function sessionTurnDuration(turn: SpeakingTurnDto): number | null {
  if (!turn.startedAt || !turn.endedAt) return null;
  return sessionElapsedSeconds(turn.startedAt, time(turn.endedAt));
}

/**
 * Amendment ids in the order the console shows them (for j/k navigation).
 * The group waiting for validation is left out: it is folded away and
 * nothing in it can be decided.
 */
export function sessionQueueOrder(
  queue: SessionQueue,
  visible: (amendment: AmendmentDto) => boolean = () => true,
): string[] {
  const ids = queue.pending.filter(visible).map((amendment) => amendment.id);
  for (const entry of queue.entries) {
    if (entry.type === "amendment") {
      if (visible(entry.amendment)) ids.push(entry.amendment.id);
    } else {
      ids.push(
        ...entry.amendments.filter(visible).map((amendment) => amendment.id),
      );
    }
  }
  return ids;
}

// Lapse suggestions ----------------------------------------------------------

export interface SessionLapseOffer {
  /** Undecided amendments the Mesa may want to mark as lapsed. */
  lapse: string[];
  /** Approved amendments that collide with this one in the base text. */
  collisions: string[];
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * What to offer after deciding `target`:
 * - approved: undecided amendments that hard-overlap it, or that are linked
 *   as incompatible, duplicate, or subsumed by it, become lapse candidates;
 *   approved ones that hard-overlap it are reported as collisions (the final
 *   consolidation would refuse them).
 * - an approved totality return: the text goes back to its proponent, so
 *   every other undecided amendment is left without object.
 * - rejected: undecided amendments that depend on it, or are a consequence of
 *   it, become lapse candidates.
 * The server's `warnings` are merged in. A transactional's own sources are
 * never offered: approving it already marks them transacted.
 */
export function sessionLapseOffer(
  target: AmendmentDto,
  list: AmendmentDto[],
  relations: RelationDto[],
  warnings: ApprovalWarnings | null = null,
): SessionLapseOffer {
  const byId = new Map(list.map((amendment) => [amendment.id, amendment]));
  const excluded = new Set([target.id, ...target.sourceIds]);
  // Amendments the Secretaría has not validated are not the Mesa's yet, and
  // late ones the assembly has not agreed to treat cannot be decided.
  const undecided = (id: string) => {
    const amendment = byId.get(id);
    return (
      !excluded.has(id) && amendment !== undefined && isSessionOpen(amendment)
    );
  };

  if (target.status === "approved" && target.kind === "totality_return") {
    return {
      lapse: sortSessionAmendments(list)
        .map((amendment) => amendment.id)
        .filter(undecided),
      collisions: [],
    };
  }

  if (target.status === "rejected") {
    const dependants = relations
      .filter(
        (relation) =>
          relation.toId === target.id &&
          (relation.kind === "depends_on" ||
            relation.kind === "consequence_of"),
      )
      .map((relation) => relation.fromId);
    return { lapse: unique(dependants.filter(undecided)), collisions: [] };
  }
  if (target.status !== "approved") return { lapse: [], collisions: [] };

  const overlapping = list
    .filter(
      (other) =>
        other.id !== target.id &&
        other.ops.length > 0 &&
        target.ops.length > 0 &&
        isHardOverlap(overlapBetween(target.ops, other.ops)),
    )
    .map((other) => other.id);

  const linked = relations.flatMap((relation) => {
    const other =
      relation.fromId === target.id
        ? relation.toId
        : relation.toId === target.id
          ? relation.fromId
          : null;
    if (!other) return [];
    if (relation.kind === "incompatible" || relation.kind === "duplicate") {
      return [other];
    }
    // "A subsumed_by target": A is absorbed by what was just approved.
    if (relation.kind === "subsumed_by" && relation.toId === target.id) {
      return [other];
    }
    return [];
  });

  const lapse = unique([
    ...overlapping,
    ...linked,
    ...(warnings?.incompatible ?? []),
  ]).filter(undecided);
  const collisions = unique([
    ...overlapping.filter((id) => byId.get(id)?.status === "approved"),
    ...(warnings?.overlapsWithApproved ?? []),
  ]).filter((id) => id !== target.id);
  return { lapse, collisions };
}

// Bulk assent ----------------------------------------------------------------

export type SessionAssentSkipReason =
  "acceptances" | "overlap_approved" | "overlap_candidate";

export interface SessionAssentPlan {
  ready: AmendmentDto[];
  skipped: {
    amendment: AmendmentDto;
    reason: SessionAssentSkipReason;
    conflictsWith: string[];
  }[];
}

/**
 * Admitted, undecided, public amendments the document's main presenter
 * accepted, ready to be approved together by assent. Those that would collide with an approved amendment,
 * or with an earlier candidate, are skipped and reported, as are
 * transactionals still missing an acceptance.
 */
export function sessionAssentPlan(list: AmendmentDto[]): SessionAssentPlan {
  const sorted = sortSessionAmendments(list);
  const approved = sorted.filter(
    (amendment) => amendment.status === "approved" && amendment.ops.length > 0,
  );
  // Private ones are left out: the server refuses to decide them.
  const candidates = sorted.filter(
    (amendment) =>
      isSessionOpen(amendment) &&
      amendment.publishedAt !== null &&
      amendment.position?.position === "accept",
  );

  const plan: SessionAssentPlan = { ready: [], skipped: [] };
  const collides = (a: AmendmentOp[], b: AmendmentOp[]) =>
    a.length > 0 && b.length > 0 && isHardOverlap(overlapBetween(a, b));

  for (const amendment of candidates) {
    if (sessionMissingAcceptances(amendment) > 0) {
      plan.skipped.push({
        amendment,
        reason: "acceptances",
        conflictsWith: [],
      });
      continue;
    }
    const withApproved = approved
      .filter((other) => collides(amendment.ops, other.ops))
      .map((other) => other.id);
    if (withApproved.length > 0) {
      plan.skipped.push({
        amendment,
        reason: "overlap_approved",
        conflictsWith: withApproved,
      });
      continue;
    }
    const withReady = plan.ready
      .filter((other) => collides(amendment.ops, other.ops))
      .map((other) => other.id);
    if (withReady.length > 0) {
      plan.skipped.push({
        amendment,
        reason: "overlap_candidate",
        conflictsWith: withReady,
      });
      continue;
    }
    plan.ready.push(amendment);
  }
  return plan;
}

// Consolidated preview -------------------------------------------------------

export interface SessionConsolidatedPreview extends ConsolidationResult {
  /** Approved amendments with text, in the order they were applied. */
  order: string[];
  /** An approved totality return: the text goes back to its proponent. */
  totalityReturn: AmendmentDto | null;
}

function decidedTime(amendment: AmendmentDto): number {
  return amendment.decidedAt ? new Date(amendment.decidedAt).getTime() : 0;
}

/**
 * The text as it stands: the base with every approved amendment applied in
 * approval order (decidedAt, then number), as the final vote does.
 * Totality returns carry no text and are left out.
 */
export function sessionConsolidatedPreview(
  base: Block[],
  list: AmendmentDto[],
): SessionConsolidatedPreview {
  const approved = list
    .filter((amendment) => amendment.status === "approved")
    .sort(
      (a, b) =>
        decidedTime(a) - decidedTime(b) ||
        (a.number ?? Number.MAX_SAFE_INTEGER) -
          (b.number ?? Number.MAX_SAFE_INTEGER) ||
        (a.code ?? "").localeCompare(b.code ?? ""),
    );
  const withText = approved.filter(
    (amendment) =>
      amendment.kind !== "totality_return" && amendment.ops.length > 0,
  );
  const result = consolidate(
    base,
    withText.map((amendment) => ({ id: amendment.id, ops: amendment.ops })),
  );
  return {
    ...result,
    order: withText.map((amendment) => amendment.id),
    totalityReturn:
      approved.find((amendment) => amendment.kind === "totality_return") ??
      null,
  };
}

// Transactional composer -----------------------------------------------------

export interface SessionTransactionalSeed {
  /** The contiguous run of base blocks the sources touch. */
  passage: Block[];
  /** The base block right before the passage, null at the start. */
  anchorBefore: string | null;
  /** The passage with the sources applied, ready for the editor. */
  seed: Block[];
  /** Sources that could not be applied together with earlier ones. */
  skipped: string[];
}

/**
 * Starting point of a transactional: the passage touched by its sources,
 * with the sources applied in the given order. When two sources collide the
 * first applicable one wins, as `consolidate` does. Blocks the sources
 * insert get fresh ids, so they never clash with the sources' own.
 */
export function sessionTransactionalSeed(
  base: Block[],
  sources: AmendmentInput[],
  newId: () => string,
): SessionTransactionalSeed {
  const index = new Map(base.map((block, i) => [block.id, i]));
  const positions: number[] = [];
  for (const source of sources) {
    for (const id of touchedBlockIds(source.ops)) {
      const position = index.get(id);
      if (position !== undefined) positions.push(position);
    }
    if (
      source.ops.some((op) => op.op === "insert" && op.afterBlockId === null)
    ) {
      positions.push(0);
    }
  }
  if (positions.length === 0 || base.length === 0) {
    return { passage: [], anchorBefore: null, seed: [], skipped: [] };
  }

  const lo = Math.min(...positions);
  const hi = Math.max(...positions);
  const result = consolidate(base, sources);

  const seed: Block[] = [];
  let current = -1;
  for (const block of result.annotated) {
    if (block.status === "inserted") {
      const inside =
        (current >= lo || (lo === 0 && current === -1)) && current <= hi;
      if (!inside) continue;
    } else {
      current = index.get(block.id) ?? current;
      if (block.status === "deleted" || current < lo || current > hi) continue;
    }
    const clean: Block = {
      id: block.status === "inserted" ? newId() : block.id,
      type: block.type,
      text: block.segments
        .filter((segment) => !segment.removed)
        .map((segment) => segment.text)
        .join(""),
      marks: block.marks,
    };
    if (block.level !== undefined) clean.level = block.level;
    if (block.list !== undefined) clean.list = block.list;
    seed.push(clean);
  }

  return {
    passage: base.slice(lo, hi + 1),
    anchorBefore: lo > 0 ? base[lo - 1]!.id : null,
    seed,
    skipped: result.conflicts.map((conflict) => conflict.amendmentId),
  };
}

/** Same ids, in any order and ignoring repeats. */
export function sessionSameIds(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function blockContent(block: Block): string {
  return JSON.stringify([
    block.type,
    block.text,
    block.level ?? null,
    block.list ?? null,
    block.marks,
  ]);
}

/**
 * Whether two block lists hold the same text and formatting. Ids are left
 * out: the editor may give a block a new id without changing its content.
 * Used to tell whether the Mesa has edited a transactional draft.
 */
export function sessionSameBlocks(a: Block[], b: Block[]): boolean {
  return (
    a.length === b.length &&
    a.every((block, index) => blockContent(block) === blockContent(b[index]!))
  );
}

export interface SessionParty {
  member: MemberRef;
  /** The sources it is the main author of, in the order given. */
  sourceIds: string[];
}

/**
 * Parties that must accept a transactional before it replaces its sources:
 * the main author of each source (sessionMainAuthor), once each, in the
 * order of the sources. A preview for the composer: once the transactional
 * exists, its `acceptances` are what counts.
 */
export function sessionTransactionalParties(
  sources: AmendmentDto[],
): SessionParty[] {
  const parties = new Map<string, SessionParty>();
  for (const source of sources) {
    const main = sessionMainAuthor(source);
    if (!main) continue;
    const party = parties.get(main.id);
    if (party) party.sourceIds.push(source.id);
    else parties.set(main.id, { member: main, sourceIds: [source.id] });
  }
  return [...parties.values()];
}

/**
 * The sources of a transactional a party answers for: those whose main
 * author it is. Sources not loaded are left out.
 */
export function sessionPartySourceIds(
  transactional: AmendmentDto,
  memberId: string,
  byId: ReadonlyMap<string, AmendmentDto>,
): string[] {
  return transactional.sourceIds.filter((id) => {
    const source = byId.get(id);
    return source !== undefined && sessionMainAuthor(source)?.id === memberId;
  });
}

// Votes ----------------------------------------------------------------------

/** A blank vote form: show of hands, no counts yet. */
export function sessionEmptyVote(majority: Majority): VoteInput {
  return {
    method: "show_of_hands",
    inFavor: 0,
    against: 0,
    abstentions: 0,
    blank: 0,
    invalid: 0,
    present: null,
    majority,
    note: null,
  };
}

/** The outcome the server will compute for a vote, for the live preview. */
export function sessionVoteOutcome(
  vote: VoteInput,
  settings: Pick<AssemblySettings, "denominator" | "tieRule">,
): VoteOutcome {
  return computeVoteOutcome(
    {
      inFavor: vote.inFavor ?? 0,
      against: vote.against ?? 0,
      abstentions: vote.abstentions ?? 0,
      blank: vote.blank ?? 0,
      invalid: vote.invalid ?? 0,
      present: vote.present ?? null,
    },
    vote.majority ?? "simple",
    settings,
  );
}

/** A vote the server would refuse: a tie to repeat or impossible counts. */
export function isSessionVoteBlocked(outcome: VoteOutcome): boolean {
  return outcome.result === "tie" || outcome.inconsistent;
}

/** Ballots cast: in favour, against, abstentions, blank and invalid. */
export function sessionVoteCast(vote: VoteInput): number {
  return (
    (vote.inFavor ?? 0) +
    (vote.against ?? 0) +
    (vote.abstentions ?? 0) +
    (vote.blank ?? 0) +
    (vote.invalid ?? 0)
  );
}

/**
 * Whether a vote form can be recorded: some ballots were counted (an empty
 * form must not record a rejection by accident) and the server would accept it.
 */
export function isSessionVoteReady(
  vote: VoteInput,
  outcome: VoteOutcome,
): boolean {
  return sessionVoteCast(vote) > 0 && !isSessionVoteBlocked(outcome);
}

/**
 * Whether the final vote on a text can be recorded. Assent (minutes, texts
 * nobody opposes) carries no counts and approves; any other method needs a
 * count the server would accept.
 */
export function isSessionFinalVoteReady(
  vote: VoteInput,
  outcome: VoteOutcome,
): boolean {
  return vote.method === "assent" || isSessionVoteReady(vote, outcome);
}

/** The result a final vote will store: assent always approves. */
export function sessionFinalVoteResult(
  vote: VoteInput,
  outcome: VoteOutcome,
): VoteOutcome["result"] {
  return vote.method === "assent" ? "approved" : outcome.result;
}

/**
 * Counts without empty fields, so the request carries what was typed. Assent
 * has no counts, present members or majority: only the method and the note.
 */
export function sessionCleanVote(vote: VoteInput): VoteInput {
  const clean: VoteInput = { method: vote.method };
  if (vote.method === "assent") {
    const note = vote.note?.trim();
    if (note) clean.note = note;
    return clean;
  }
  for (const key of [
    "inFavor",
    "against",
    "abstentions",
    "blank",
    "invalid",
  ] as const) {
    const value = vote[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      clean[key] = Math.max(0, Math.trunc(value));
    }
  }
  if (typeof vote.present === "number" && Number.isFinite(vote.present)) {
    clean.present = Math.max(0, Math.trunc(vote.present));
  }
  if (vote.majority) clean.majority = vote.majority;
  const note = vote.note?.trim();
  if (note) clean.note = note;
  return clean;
}

// Agenda ---------------------------------------------------------------------

export interface SessionAgendaRow {
  item: AgendaItemDto;
  depth: number;
  /** Visible numbering, e.g. "2.1". */
  number: string;
  documents: DocumentSummaryDto[];
}

/**
 * The agenda tree flattened depth-first, with its numbering and the
 * documents of each item. Items whose parent is missing are treated as roots,
 * and cycles are cut.
 */
export function buildSessionAgendaRows(
  items: AgendaItemDto[],
  documents: DocumentSummaryDto[],
): SessionAgendaRow[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string | null, AgendaItemDto[]>();
  for (const item of items) {
    const parent =
      item.parentId && ids.has(item.parentId) ? item.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }
  const docsByItem = new Map<string, DocumentSummaryDto[]>();
  for (const document of documents) {
    const list = docsByItem.get(document.agendaItemId) ?? [];
    list.push(document);
    docsByItem.set(document.agendaItemId, list);
  }

  const rows: SessionAgendaRow[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number, prefix: string) => {
    (children.get(parent) ?? []).forEach((item, i) => {
      if (visited.has(item.id)) return;
      visited.add(item.id);
      const number = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      rows.push({
        item,
        depth,
        number,
        documents: docsByItem.get(item.id) ?? [],
      });
      walk(item.id, depth + 1, number);
    });
  };
  walk(null, 0, "");
  return rows;
}

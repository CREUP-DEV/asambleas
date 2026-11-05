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
  AcceptanceRole,
  AmendmentStatus,
  AssemblySettings,
  Majority,
} from "~~/shared/constants/domain";
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

// Validation by the Secretaría ------------------------------------------------

/**
 * A transactional proposed by a member, waiting for whoever presents the
 * document to approve it before the Secretaría checks it. Draft or
 * presented, it is not the Mesa's yet.
 */
export function isSessionAwaitingProponent(amendment: AmendmentDto): boolean {
  return (
    amendment.reviewState === "pending_proponent" &&
    (amendment.status === "submitted" || amendment.status === "draft")
  );
}

/**
 * A transactional proposed by a member that whoever presents the document
 * turned down. It stays presented and private, and the final vote waits for
 * it, until whoever proposed it (or the Mesa) withdraws it. The presenter's
 * answer is the acceptance of the document's proponent member, whatever its
 * role (it may also have written a source): `presenterId` names it, and
 * without it the row with the `proponent` role is taken.
 */
export function isSessionProponentRejected(
  amendment: AmendmentDto,
  presenterId: string | null = null,
): boolean {
  if (!isSessionAwaitingProponent(amendment)) return false;
  return amendment.acceptances.some(
    (party) =>
      party.decision === "rejected" &&
      (presenterId
        ? party.member.id === presenterId
        : party.role === "proponent"),
  );
}

/**
 * Not checked by the Secretaría yet: a transactional still waiting for the
 * document's presenter, presented and waiting for validation, or sent back
 * to its authors for a correction (a draft again). The Mesa cannot debate,
 * admit or decide it until the Secretaría validates it.
 */
export function isSessionAwaitingValidation(amendment: AmendmentDto): boolean {
  return (
    isSessionAwaitingProponent(amendment) ||
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
 * server refuses private sources: delegates could not read what is merged).
 */
export function isSessionTransactable(amendment: AmendmentDto): boolean {
  return isSessionOpen(amendment) && amendment.publishedAt !== null;
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
 * yet are counted apart, since the Mesa cannot decide them.
 */
export function sessionQueueCounts(list: AmendmentDto[]): {
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
 * correction), whoever presents the document (a transactional proposed by a
 * member, not approved by the presenter yet) or whoever proposed it (one
 * the presenter turned down, to be withdrawn).
 */
export function sessionValidationBreakdown(
  list: AmendmentDto[],
  presenterId: string | null = null,
): {
  toValidate: number;
  inCorrection: number;
  awaitingProponent: number;
  proponentRejected: number;
} {
  const awaiting = list.filter(isSessionAwaitingValidation);
  const inCorrection = awaiting.filter(
    (amendment) => amendment.reviewState === "correction_requested",
  ).length;
  const withPresenter = awaiting.filter(isSessionAwaitingProponent);
  const proponentRejected = withPresenter.filter((amendment) =>
    isSessionProponentRejected(amendment, presenterId),
  ).length;
  return {
    toValidate: awaiting.length - inCorrection - withPresenter.length,
    inCorrection,
    awaitingProponent: withPresenter.length - proponentRejected,
    proponentRejected,
  };
}

/**
 * What still stops the final vote, split by who has to act, in text order.
 * The server blocks it while any amendment is submitted, validated or not:
 * the Mesa decides the validated ones (`undecided`); the Secretaría has to
 * validate the rest or send them back to their authors
 * (`awaitingValidation`), except the transactionals the document's
 * presenter has not approved yet (`awaitingProponent`) and those it turned
 * down, which whoever proposed them or the Mesa has to withdraw
 * (`proponentRejected`). `serverIds` are the ids a refused final vote
 * reported (409 `{ undecided }`): they count too, unless the console
 * already knows they are decided. Ids the console has not loaded count as
 * undecided. `presenterId` is the document's proponent member.
 */
export function sessionFinalVoteBlockers(
  list: AmendmentDto[],
  serverIds: string[] = [],
  presenterId: string | null = null,
): {
  undecided: string[];
  awaitingValidation: string[];
  awaitingProponent: string[];
  proponentRejected: string[];
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
  const awaitingValidation: string[] = [];
  const awaitingProponent: string[] = [];
  const proponentRejected: string[] = [];
  for (const id of ids) {
    const amendment = byId.get(id);
    if (amendment && isSessionProponentRejected(amendment, presenterId)) {
      proponentRejected.push(id);
    } else if (amendment && isSessionAwaitingProponent(amendment)) {
      awaitingProponent.push(id);
    } else if (amendment && isSessionAwaitingValidation(amendment)) {
      awaitingValidation.push(id);
    } else {
      undecided.push(id);
    }
  }
  return {
    undecided,
    awaitingValidation,
    awaitingProponent,
    proponentRejected,
  };
}

export type SessionFinalVoteReason =
  | { key: "notVoted" }
  | { key: "notPublished" }
  | { key: "amendmentsLoading" }
  | { key: "totalityReturn"; id: string }
  | { key: "undecided"; count: number }
  | { key: "awaitingValidation"; count: number }
  | { key: "awaitingProponent"; count: number }
  | { key: "proponentRejected"; count: number };

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
  if (blockers.undecided.length > 0) {
    reasons.push({ key: "undecided", count: blockers.undecided.length });
  }
  if (blockers.awaitingValidation.length > 0) {
    reasons.push({
      key: "awaitingValidation",
      count: blockers.awaitingValidation.length,
    });
  }
  if (blockers.awaitingProponent.length > 0) {
    reasons.push({
      key: "awaitingProponent",
      count: blockers.awaitingProponent.length,
    });
  }
  if (blockers.proponentRejected.length > 0) {
    reasons.push({
      key: "proponentRejected",
      count: blockers.proponentRejected.length,
    });
  }
  return reasons;
}

// Debate ---------------------------------------------------------------------

/**
 * Where an amendment stands in the session, as one status the console and
 * the queue show with what happens next:
 * - `awaiting_proponent`: a transactional the document's presenter has not
 *   approved yet;
 * - `proponent_rejected`: one the presenter turned down, waiting to be
 *   withdrawn by whoever proposed it or the Mesa;
 * - `awaiting_validation`: the Secretaría has not checked it;
 * - `correction_requested`: back with its authors for a correction;
 * - `late`: validated but presented after the deadline, waiting for the
 *   assembly's decision to treat it;
 * - `acceptances`: a transactional some party has not accepted yet;
 * - `open`: the Mesa can decide it now;
 * - otherwise its final status.
 */
export type SessionAmendmentStage =
  | "awaiting_proponent"
  | "proponent_rejected"
  | "awaiting_validation"
  | "correction_requested"
  | "late"
  | "acceptances"
  | "open"
  | Exclude<AmendmentStatus, "submitted">;

/** `presenterId`: the document's proponent member (isSessionProponentRejected). */
export function sessionAmendmentStage(
  amendment: AmendmentDto,
  presenterId: string | null = null,
): SessionAmendmentStage {
  if (isSessionProponentRejected(amendment, presenterId)) {
    return "proponent_rejected";
  }
  if (isSessionAwaitingProponent(amendment)) return "awaiting_proponent";
  if (isSessionAwaitingValidation(amendment)) {
    return amendment.reviewState === "correction_requested"
      ? "correction_requested"
      : "awaiting_validation";
  }
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
 * cannot publish and decided ones are never offered. Null when nothing else
 * is left.
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
    return amendment !== undefined && debatable(amendment);
  });
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
 * Admitted, undecided, public amendments the proponent accepted, ready to be
 * approved together by assent. Those that would collide with an approved amendment,
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
  role: AcceptanceRole;
}

/**
 * Parties that must accept a transactional: every author of every source,
 * then the document proponent (mirrors the server's acceptance rows).
 */
export function sessionTransactionalParties(
  sources: AmendmentDto[],
  proponent: MemberRef | null,
): SessionParty[] {
  const parties = new Map<string, SessionParty>();
  for (const source of sources) {
    for (const author of source.authors) {
      if (!parties.has(author.id)) {
        parties.set(author.id, { member: author, role: "author" });
      }
    }
  }
  if (proponent && !parties.has(proponent.id)) {
    parties.set(proponent.id, { member: proponent, role: "proponent" });
  }
  return [...parties.values()];
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

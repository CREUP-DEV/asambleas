/**
 * Pure helpers of the Mesa session console and the projection screen. No Vue
 * or Nuxt here: everything takes DTOs and returns plain data, so the console
 * composable and the components stay thin.
 */
import type {
  AgendaItemDto,
  AmendmentDto,
  DocumentSummaryDto,
  MemberRef,
  RelationDto,
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

/** Submitted and admitted: the Mesa can decide it now. */
export function isSessionOpen(amendment: AmendmentDto): boolean {
  return amendment.status === "submitted" && amendment.admission === "admitted";
}

/** Late (or manually reviewed) and still waiting for an admission decision. */
export function isSessionPendingAdmission(amendment: AmendmentDto): boolean {
  return amendment.status === "submitted" && amendment.admission === "pending";
}

/** A transactional that still lacks the acceptance of some party. */
export function sessionMissingAcceptances(amendment: AmendmentDto): number {
  if (amendment.kind !== "transactional") return 0;
  return amendment.acceptances.filter((party) => party.decision !== "accepted")
    .length;
}

/** Whether the Mesa may approve or vote it right now. */
export function isSessionDecidable(amendment: AmendmentDto): boolean {
  return isSessionOpen(amendment) && sessionMissingAcceptances(amendment) === 0;
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
      /** Members the Mesa can still transact (submitted and admitted). */
      openIds: string[];
    };

export interface SessionQueue {
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
    (amendment.status === "submitted" || amendment.status === "approved")
  );
}

/**
 * The console queue of a document. Drafts are left out. Late amendments
 * pending admission come first; the rest follow the text, and amendments
 * that act on the same passage (findOverlaps) are grouped where the first of
 * them appears.
 */
export function buildSessionQueue(list: AmendmentDto[]): SessionQueue {
  const sorted = sortSessionAmendments(
    list.filter((amendment) => amendment.status !== "draft"),
  );
  const pending = sorted.filter(isSessionPendingAdmission);
  const rest = sorted.filter(
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
      openIds: members.filter(isSessionOpen).map((other) => other.id),
    });
  }
  return { pending, entries };
}

/** Amendment ids in the order the console shows them (for j/k navigation). */
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

export interface SessionApprovalWarnings {
  overlapsWithApproved: string[];
  incompatible: string[];
}

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
 * - rejected: undecided amendments that depend on it, or are a consequence of
 *   it, become lapse candidates.
 * The server's `warnings` are merged in. A transactional's own sources are
 * never offered: approving it already marks them transacted.
 */
export function sessionLapseOffer(
  target: AmendmentDto,
  list: AmendmentDto[],
  relations: RelationDto[],
  warnings: SessionApprovalWarnings | null = null,
): SessionLapseOffer {
  const byId = new Map(list.map((amendment) => [amendment.id, amendment]));
  const excluded = new Set([target.id, ...target.sourceIds]);
  const undecided = (id: string) =>
    !excluded.has(id) && byId.get(id)?.status === "submitted";

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
 * Admitted, undecided amendments the proponent accepted, ready to be approved
 * together by assent. Those that would collide with an approved amendment,
 * or with an earlier candidate, are skipped and reported, as are
 * transactionals still missing an acceptance.
 */
export function sessionAssentPlan(list: AmendmentDto[]): SessionAssentPlan {
  const sorted = sortSessionAmendments(list);
  const approved = sorted.filter(
    (amendment) => amendment.status === "approved" && amendment.ops.length > 0,
  );
  const candidates = sorted.filter(
    (amendment) =>
      isSessionOpen(amendment) && amendment.position?.position === "accept",
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

/** Counts without empty fields, so the request carries what was typed. */
export function sessionCleanVote(vote: VoteInput): VoteInput {
  const clean: VoteInput = { method: vote.method };
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

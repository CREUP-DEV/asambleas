import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { db } from "../../db";
import { amendmentSources, amendments, events } from "../../db/schema";
import type {
  AcceptanceDecision,
  AcceptanceRole,
  AdmissionStatus,
  AmendmentStatus,
} from "~~/shared/constants/domain";
import type { Actor } from "./actor";
import { recordEvent } from "./events";
import {
  authorsApproval,
  transactionalReopenBlocker,
  unopenSourceReason,
} from "./reviewState";

/**
 * Transactionals left without what they group (docs/design.md,
 * "Transactionals"). A transactional that has not replaced its sources yet
 * (still waiting for its main authors, for the Secretaría or, when the Mesa
 * presented it, for the answers given in the room) can no longer go through
 * once one of those amendments is settled: decided, withdrawn, lapsed,
 * declared inadmissible or incorporated by the main presenter's acceptance.
 * It is closed at once (withdrawn, `amendment_withdrawn` with
 * `by: "sources_closed"` and the amendment that closed it), so nobody is
 * asked to answer it any more and its authors and parties read why in their
 * news. One left behind because another transactional replaced its sources
 * lapses instead (replaceSources in amendments.ts, reason
 * "sources_transacted").
 *
 * Every path that settles an amendment locks the transactionals over it in
 * the same ordered pass as the amendment (findCompetitors and
 * lockAmendments in amendments.ts, or the rule change in acceptedRule.ts),
 * and calls closeTransactionalsOver after the change.
 *
 * It is undone the same way: when an amendment such a transactional groups
 * goes back to undecided before the final vote (the main presenter changes
 * an answer that had incorporated it, the Mesa reopens its decision, the
 * rule for accepted amendments goes back to "vote", the assembly readmits
 * it), the transactional comes back (reopenTransactionalsClosedBy), as long
 * as nobody withdrew it since and it could go through: every amendment it
 * groups open again, in whatever order they were reopened, and no main
 * author against it (transactionalsToRestore). Those paths lock the
 * transactionals over the amendment and their other sources in the same
 * ordered pass (restoreLockIds), then their acceptances.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** transactional id -> its source ids, from `amendment_sources` rows. */
export function buildSourceMap(
  rows: { transactionalId: string; sourceId: string }[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const entry = map.get(row.transactionalId) ?? [];
    entry.push(row.sourceId);
    map.set(row.transactionalId, entry);
  }
  return map;
}

/**
 * The other transactionals of a document that group one of `sourceIds`
 * (from buildSourceMap), leaving out `transactionalId`. When those
 * amendments are replaced by a transactional or settled otherwise, these can
 * no longer go through.
 */
export function competingTransactionalIds(
  sourceMap: ReadonlyMap<string, readonly string[]>,
  transactionalId: string | null,
  sourceIds: readonly string[],
): string[] {
  const wanted = new Set(sourceIds);
  const result: string[] = [];
  for (const [id, sources] of sourceMap) {
    if (id === transactionalId) continue;
    if (sources.some((sourceId) => wanted.has(sourceId))) result.push(id);
  }
  return result;
}

/**
 * Which transactionals to close because an amendment they group was just
 * settled (`closedIds`), with the first such amendment for each. Only the
 * ones still `submitted` among `candidates` (their locked rows) count: a
 * transactional that had replaced its sources would have them `transacted`,
 * never settled here, so every one left is still pending. The settled
 * amendments themselves are never closed by this. In candidate order.
 */
export function transactionalsToClose(
  sourceMap: ReadonlyMap<string, readonly string[]>,
  closedIds: readonly string[],
  candidates: readonly { id: string; status: AmendmentStatus }[],
): { id: string; sourceId: string }[] {
  const closed = new Set(closedIds);
  const result: { id: string; sourceId: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (
      candidate.status !== "submitted" ||
      closed.has(candidate.id) ||
      seen.has(candidate.id)
    ) {
      continue;
    }
    const sourceId = (sourceMap.get(candidate.id) ?? []).find((id) =>
      closed.has(id),
    );
    if (sourceId === undefined) continue;
    seen.add(candidate.id);
    result.push({ id: candidate.id, sourceId });
  }
  return result;
}

/** Every transactional -> sources edge of the document. */
export async function loadSourceMap(
  executor: Executor,
  documentId: string,
): Promise<Map<string, string[]>> {
  const rows = await executor
    .select({
      transactionalId: amendmentSources.transactionalId,
      sourceId: amendmentSources.sourceId,
    })
    .from(amendmentSources)
    .innerJoin(amendments, eq(amendments.id, amendmentSources.transactionalId))
    .where(eq(amendments.documentId, documentId));
  return buildSourceMap(rows);
}

/**
 * Closes the pending transactionals over amendments just settled
 * (transactionalsToClose): `withdrawn`, `decidedAt`, and
 * `amendment_withdrawn` with `{ by: "sources_closed", sourceId, sourceCode,
 * sourceStatus }`, the amendment that closed it and where it ended up.
 * `decidedAt` is the same instant the settled amendment got (`now`), so a
 * client tells from the AmendmentDto alone which of its sources closed it
 * and puts the reason into words in the viewer's language. The outcome note
 * stays empty, for the Mesa's own words: a Spanish note written here would
 * reach English readers untranslated and hide that sentence. The caller
 * holds the locks of the settled amendments and of `candidates`, taken in
 * one ordered pass.
 */
export async function closeTransactionalsOver(
  tx: Tx,
  input: {
    assemblyId: string;
    documentId: string;
    actor: Actor;
    now: Date;
    sourceMap: ReadonlyMap<string, readonly string[]>;
    /** The amendments just settled, with the status they took. */
    closed: { id: string; code: string | null; status: AmendmentStatus }[];
    /** Locked rows of the transactionals over them. */
    candidates: readonly { id: string; status: AmendmentStatus }[];
  },
): Promise<string[]> {
  const plan = transactionalsToClose(
    input.sourceMap,
    input.closed.map((row) => row.id),
    input.candidates,
  );
  if (plan.length === 0) return [];
  const updated = await tx
    .update(amendments)
    .set({ status: "withdrawn", decidedAt: input.now, outcomeNote: null })
    .where(
      and(
        inArray(
          amendments.id,
          plan.map((item) => item.id),
        ),
        eq(amendments.status, "submitted"),
      ),
    )
    .returning({ id: amendments.id });
  const closedIds = new Set(updated.map((row) => row.id));
  const sourceById = new Map(input.closed.map((row) => [row.id, row]));
  for (const item of plan) {
    if (!closedIds.has(item.id)) continue;
    const source = sourceById.get(item.sourceId)!;
    await recordEvent(tx, {
      assemblyId: input.assemblyId,
      documentId: input.documentId,
      entityType: "amendment",
      entityId: item.id,
      type: "amendment_withdrawn",
      payload: {
        by: "sources_closed",
        sourceId: source.id,
        sourceCode: source.code,
        sourceStatus: source.status,
      },
      actor: input.actor,
    });
  }
  return [...closedIds];
}

/**
 * The transactionals of a document that group one of `ids` (from
 * buildSourceMap), leaving out `ids` themselves, in id order: the ones
 * reopening those amendments may restore.
 */
export function transactionalsOverIds(
  sourceMap: ReadonlyMap<string, readonly string[]>,
  ids: readonly string[],
): string[] {
  const own = new Set(ids);
  return competingTransactionalIds(sourceMap, null, ids)
    .filter((id) => !own.has(id))
    .sort();
}

/**
 * What a path that reopens `ids` locks beside them, in the same ordered
 * pass: the transactionals over them and every amendment those group, whose
 * state decides whether each can come back (transactionalsToRestore).
 */
export function restoreLockIds(
  sourceMap: ReadonlyMap<string, readonly string[]>,
  ids: readonly string[],
): string[] {
  const result = new Set<string>();
  for (const id of transactionalsOverIds(sourceMap, ids)) {
    result.add(id);
    for (const sourceId of sourceMap.get(id) ?? []) result.add(sourceId);
  }
  for (const id of ids) result.delete(id);
  return [...result].sort();
}

/** What transactionalsToRestore reads of a locked amendment row. */
export interface RestoreRow {
  status: AmendmentStatus;
  admission: AdmissionStatus;
  validatedAt: Date | null;
  decidedAt: Date | null;
}

/** An acceptance row of a transactional (amendment_acceptances). */
interface PartyRow {
  amendmentId: string;
  role: AcceptanceRole;
  decision: AcceptanceDecision;
}

/**
 * Which transactionals come back because amendments they group were just
 * reopened (`reopened`, their ids), each with a reopened amendment to name
 * (not always the one whose settling closed it, see below). One comes back
 * only when:
 * - it is still `withdrawn` and its latest withdrawal (`withdrawals`, the
 *   payload of its latest amendment_withdrawn) was the automatic one,
 *   `by: "sources_closed"`: nobody chose to withdraw it;
 * - it groups one of the reopened amendments;
 * - it could go through again (transactionalReopenBlocker): every amendment
 *   it groups open in `rows` (the reopened ones as they stand now) and no
 *   main author rejected it (`parties`, its acceptance rows).
 * What closed it is then undone, whichever of its amendments was settled
 * first and whichever is reopened last: one over A and B, closed by A's
 * settling, with B settled later, comes back when the second of the two is
 * reopened, in either order. So does a closure left from before this rule,
 * once everything it groups is open. It names the amendment its event
 * names when that one is among the reopened ones, else the first reopened
 * one it groups. Never one being reopened itself. In id order.
 */
export function transactionalsToRestore(input: {
  sourceMap: ReadonlyMap<string, readonly string[]>;
  reopened: readonly string[];
  rows: ReadonlyMap<string, RestoreRow>;
  withdrawals: ReadonlyMap<string, Record<string, unknown>>;
  parties: readonly PartyRow[];
}): { id: string; sourceId: string }[] {
  const result: { id: string; sourceId: string }[] = [];
  const reopened = new Set(input.reopened);
  for (const id of transactionalsOverIds(input.sourceMap, input.reopened)) {
    const row = input.rows.get(id);
    // closeTransactionalsOver always dates the closure.
    if (!row || row.status !== "withdrawn" || !row.decidedAt) continue;
    const withdrawal = input.withdrawals.get(id);
    if (!withdrawal || withdrawal.by !== "sources_closed") continue;
    const sourceIds = input.sourceMap.get(id) ?? [];
    const named =
      typeof withdrawal.sourceId === "string" &&
      reopened.has(withdrawal.sourceId)
        ? withdrawal.sourceId
        : sourceIds.find((sourceId) => reopened.has(sourceId));
    if (!named) continue;
    const sources = sourceIds.map((other) => input.rows.get(other));
    const present = sources.filter((source) => source !== undefined);
    if (
      present.length === 0 ||
      present.length !== sources.length ||
      present.some((source) => unopenSourceReason(source) !== null)
    ) {
      continue;
    }
    const blocker = transactionalReopenBlocker({
      kind: "transactional",
      validatedAt: row.validatedAt,
      authorsApproval: authorsApproval({
        kind: "transactional",
        acceptances: input.parties.filter((party) => party.amendmentId === id),
      }),
      sources: present,
    });
    if (blocker) continue;
    result.push({ id, sourceId: named });
  }
  return result;
}

/**
 * The rows transactionalsToRestore reads, by id: every locked row as it was
 * locked (`locked`: the reopened amendments and restoreLockIds), with the
 * reopened ones (`reopened`) as the reopening left them: `submitted` and
 * undecided, plus whatever else it changed (`reopenedAs`; readmission also
 * admits them).
 */
export function rowsAfterReopen(
  locked: Iterable<RestoreRow & { id: string }>,
  reopened: Iterable<string>,
  reopenedAs: Partial<RestoreRow> = {},
): Map<string, RestoreRow> {
  const rows = new Map<string, RestoreRow>();
  for (const row of locked) {
    rows.set(row.id, {
      status: row.status,
      admission: row.admission,
      validatedAt: row.validatedAt,
      decidedAt: row.decidedAt,
    });
  }
  for (const id of reopened) {
    const row = rows.get(id);
    if (!row) continue;
    rows.set(id, {
      ...row,
      status: "submitted",
      decidedAt: null,
      ...reopenedAs,
    });
  }
  return rows;
}

/**
 * Brings back the transactionals that amendments just reopened let go
 * through again (transactionalsToRestore): `submitted` again with
 * `decidedAt` cleared (closeTransactionalsOver left no outcome note), and
 * `amendment_reopened` with `{ previousStatus: "withdrawn", reason:
 * "source_reopened", sourceId, sourceCode }`, the reopened amendment it
 * names. Nobody decided about it, as when it closed: its news names nobody
 * and reaches its parties too (isAutomaticChange in news.ts). It never
 * replaced what it groups, so nothing builds on it and nothing else comes
 * back. The caller holds, in one ordered pass, the locks of the reopened
 * amendments and of restoreLockIds (`locked`, the rows as they were
 * locked, before the reopening), then the acceptances of the
 * transactionals over them (`parties`). Never after the final vote: no
 * reopening happens then. Answers the ids it brought back, in id order.
 */
export async function reopenTransactionalsClosedBy(
  tx: Tx,
  input: {
    assemblyId: string;
    documentId: string;
    actor: Actor;
    sourceMap: ReadonlyMap<string, readonly string[]>;
    /** The amendments just put back to undecided. */
    reopened: { id: string; code: string | null }[];
    /** Locked rows as locked before: the reopened ones and restoreLockIds. */
    locked: Iterable<RestoreRow & { id: string }>;
    /** What else the reopening changed on the reopened rows. */
    reopenedAs?: Partial<RestoreRow>;
    /** Locked acceptance rows of the transactionals over them. */
    parties: readonly PartyRow[];
  },
): Promise<string[]> {
  if (input.reopened.length === 0) return [];
  const reopened = new Map(input.reopened.map((row) => [row.id, row]));
  const reopenedIds = [...reopened.keys()];
  const rows = rowsAfterReopen(input.locked, reopenedIds, input.reopenedAs);
  const candidates = transactionalsOverIds(input.sourceMap, reopenedIds).filter(
    (id) => rows.get(id)?.status === "withdrawn",
  );
  if (candidates.length === 0) return [];
  const plan = transactionalsToRestore({
    sourceMap: input.sourceMap,
    reopened: reopenedIds,
    rows,
    withdrawals: latestByEntity(await loadWithdrawals(tx, candidates)),
    parties: input.parties,
  });
  if (plan.length === 0) return [];
  const updated = await tx
    .update(amendments)
    .set({ status: "submitted", decidedAt: null })
    .where(
      and(
        inArray(
          amendments.id,
          plan.map((item) => item.id),
        ),
        eq(amendments.status, "withdrawn"),
      ),
    )
    .returning({ id: amendments.id });
  const restored = new Set(updated.map((row) => row.id));
  const result: string[] = [];
  for (const item of plan) {
    if (!restored.has(item.id)) continue;
    const source = reopened.get(item.sourceId)!;
    await recordEvent(tx, {
      assemblyId: input.assemblyId,
      documentId: input.documentId,
      entityType: "amendment",
      entityId: item.id,
      type: "amendment_reopened",
      payload: {
        previousStatus: "withdrawn",
        reason: "source_reopened",
        sourceId: source.id,
        sourceCode: source.code,
      },
      actor: input.actor,
    });
    result.push(item.id);
  }
  return result;
}

/**
 * The payload of the first row of each entity, from rows sorted by entity
 * and newest first (loadWithdrawals): the latest event of each.
 */
export function latestByEntity(
  rows: readonly { entityId: string; payload: Record<string, unknown> }[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!result.has(row.entityId)) result.set(row.entityId, row.payload);
  }
  return result;
}

/**
 * The amendment_withdrawn events of `ids`, by amendment and newest first
 * (closure events are stamped with clock_timestamp, so the order holds
 * within one transaction too), as latestByEntity reads them.
 */
function loadWithdrawals(
  executor: Executor,
  ids: string[],
): Promise<{ entityId: string; payload: Record<string, unknown> }[]> {
  return executor
    .select({ entityId: events.entityId, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.entityType, "amendment"),
        eq(events.type, "amendment_withdrawn"),
        inArray(events.entityId, ids),
      ),
    )
    .orderBy(asc(events.entityId), desc(events.createdAt), desc(events.id));
}

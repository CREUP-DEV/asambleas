import { and, eq, inArray } from "drizzle-orm";
import type { db } from "../../db";
import { amendmentSources, amendments } from "../../db/schema";
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type { Actor } from "./actor";
import { recordEvent } from "./events";

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

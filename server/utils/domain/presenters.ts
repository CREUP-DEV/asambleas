import { and, asc, eq, exists, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import {
  amendmentAuthors,
  amendmentSources,
  documentProponents,
  documents,
  members,
} from "../../db/schema";
import type { MemberRef } from "~~/shared/types/api";
import { toMemberRef } from "../members/dto";

/**
 * Who presents a document besides its main presenter (document_proponents),
 * and who is involved in a transactional besides its parties. Loaders shared
 * by the resolvers, the document and amendment modules and the home page,
 * plus the pure rule for setting the presenters of a document
 * (planPresenters). docs/design.md, "Main presenter and main author".
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function group<T>(rows: { key: string; value: T }[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.key) ?? [];
    list.push(row.value);
    map.set(row.key, list);
  }
  return map;
}

/** Co-presenters of these documents, by acronym. */
export async function loadCoProponents(
  documentIds: string[],
  executor: Executor = db,
): Promise<Map<string, MemberRef[]>> {
  if (documentIds.length === 0) return new Map();
  const rows = await executor
    .select({
      documentId: documentProponents.documentId,
      id: members.id,
      acronym: members.acronym,
      name: members.name,
      kind: members.kind,
    })
    .from(documentProponents)
    .innerJoin(members, eq(members.id, documentProponents.memberId))
    .where(inArray(documentProponents.documentId, documentIds))
    .orderBy(asc(members.acronym));
  return group(
    rows.map((row) => ({ key: row.documentId, value: toMemberRef(row) })),
  );
}

/** Member ids of the co-presenters of these documents. */
export async function loadCoProponentIds(
  documentIds: string[],
  executor: Executor = db,
): Promise<Map<string, string[]>> {
  if (documentIds.length === 0) return new Map();
  const rows = await executor
    .select({
      documentId: documentProponents.documentId,
      memberId: documentProponents.memberId,
    })
    .from(documentProponents)
    .where(inArray(documentProponents.documentId, documentIds));
  return group(
    rows.map((row) => ({ key: row.documentId, value: row.memberId })),
  );
}

/** Document rows with their co-presenters (`coProponentMemberIds`). */
export async function withCoProponentIds<T extends { id: string }>(
  rows: T[],
  executor: Executor = db,
): Promise<(T & { coProponentMemberIds: string[] })[]> {
  const ids = await loadCoProponentIds(
    rows.map((row) => row.id),
    executor,
  );
  return rows.map((row) => ({
    ...row,
    coProponentMemberIds: ids.get(row.id) ?? [],
  }));
}

/** Replaces the co-presenters of a document. */
export async function saveCoProponents(
  executor: Executor,
  documentId: string,
  memberIds: readonly string[],
): Promise<void> {
  await executor
    .delete(documentProponents)
    .where(eq(documentProponents.documentId, documentId));
  if (memberIds.length === 0) return;
  await executor
    .insert(documentProponents)
    .values(memberIds.map((memberId) => ({ documentId, memberId })))
    .onConflictDoNothing();
}

/**
 * SQL: the document (`documents` in the outer query) is co-presented by this
 * member. The mirror of the co-presenter part of isDocumentPresenter.
 */
export function coPresentedBy(memberId: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(documentProponents)
      .where(
        and(
          eq(documentProponents.documentId, documents.id),
          eq(documentProponents.memberId, memberId),
        ),
      ),
  );
}

/**
 * Authors (main and co-authors) of the amendments each transactional would
 * replace, by transactional. They are insiders of the transactional: they
 * see it while it is private, as its parties (their main authors) do.
 */
export async function loadSourceAuthorIds(
  transactionalIds: string[],
  executor: Executor = db,
): Promise<Map<string, string[]>> {
  if (transactionalIds.length === 0) return new Map();
  const rows = await executor
    .select({
      transactionalId: amendmentSources.transactionalId,
      memberId: amendmentAuthors.memberId,
    })
    .from(amendmentSources)
    .innerJoin(
      amendmentAuthors,
      eq(amendmentAuthors.amendmentId, amendmentSources.sourceId),
    )
    .where(inArray(amendmentSources.transactionalId, transactionalIds));
  return group(
    rows.map((row) => ({ key: row.transactionalId, value: row.memberId })),
  );
}

// Setting the presenters (pure) ------------------------------------------------

export interface Presenters {
  proponentMemberId: string | null;
  coProponentMemberIds: string[];
}

export type PresentersError = "main_required" | "own_member_required";

export const PRESENTERS_MESSAGES: Record<PresentersError, string> = {
  main_required:
    "Indica quién presenta principalmente el documento: es quien responde a las enmiendas",
  own_member_required:
    "Tu consejo o área tiene que seguir entre quienes presentan el documento",
};

function unique(values: (string | null | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

/**
 * The presenters a create or update leaves on a document, or why not
 * (docs/api.md, "Presenters"). The bodies name the main presenter apart
 * from the co-presenters (DocumentCreateBody), so the main presenter named
 * is always one of the presenters:
 * - with co-presenters there must be a main presenter (`main_required`);
 * - managers set any main presenter and co-presenters (on create the main
 *   one defaults to their own member);
 * - a member presenting its own document is always one of its presenters
 *   (`own_member_required`): on create its member joins the co-presenters
 *   unless it is the main one, and it may name any member as the main one
 *   (adding a member and choosing it are the same act); on an update of its
 *   draft its member cannot leave;
 * - on an update, fields left out keep their value. Naming a new main
 *   presenter without sending the co-presenters keeps the former one as a
 *   co-presenter: always for a member, and for a manager when the new one
 *   was already a presenter (a swap within the group; otherwise a manager
 *   replaces it);
 * - the main presenter is never listed among the co-presenters.
 * `current` is null on a create.
 */
export function planPresenters(input: {
  manager: boolean;
  actorMemberId: string | null;
  current: Presenters | null;
  proponentMemberId: string | null | undefined;
  coProponentMemberIds: string[] | undefined;
}): Presenters | PresentersError {
  const { manager, actorMemberId, current } = input;
  const own = manager ? null : actorMemberId;
  const requested = input.proponentMemberId;
  let main: string | null;
  let co: string[];

  if (current === null) {
    co = unique([...(input.coProponentMemberIds ?? []), own]);
    main = manager
      ? requested !== undefined
        ? requested
        : actorMemberId
      : (requested ?? (co.length > 1 ? null : own));
  } else {
    const before = unique([
      current.proponentMemberId,
      ...current.coProponentMemberIds,
    ]);
    co = input.coProponentMemberIds ?? current.coProponentMemberIds;
    main = requested !== undefined ? requested : current.proponentMemberId;
    if (
      input.coProponentMemberIds === undefined &&
      current.proponentMemberId &&
      main !== current.proponentMemberId &&
      main !== null &&
      (!manager || before.includes(main))
    ) {
      co = [...co, current.proponentMemberId];
    }
  }

  co = unique(co).filter((id) => id !== main);
  if (co.length > 0 && !main) return "main_required";
  if (own && main !== own && !co.includes(own)) return "own_member_required";
  return { proponentMemberId: main, coProponentMemberIds: co };
}

/** Whether two presenter sets differ (the co-presenters in any order). */
export function presentersChanged(a: Presenters, b: Presenters): boolean {
  if (a.proponentMemberId !== b.proponentMemberId) return true;
  const left = new Set(a.coProponentMemberIds);
  return (
    left.size !== new Set(b.coProponentMemberIds).size ||
    b.coProponentMemberIds.some((id) => !left.has(id))
  );
}

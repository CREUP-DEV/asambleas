import { isOnline } from "../live/online";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  max,
  min,
  ne,
  sql,
  sum,
} from "drizzle-orm";
import { db } from "../../db";
import {
  amendmentAuthors,
  amendmentReads,
  amendments,
  auditLog,
  documentReads,
  documentViews,
  documents,
  headcountEntries,
  headcounts,
  members,
  roles,
  speakingTurns,
  users,
} from "../../db/schema";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type {
  MemberRef,
  ReadState,
  StatsAccountDetailDto,
  StatsAccountDto,
  StatsAmendmentOutcomes,
  StatsDocumentDto,
  StatsDto,
  StatsMemberDto,
  StatsOpeningDto,
  StatsReadingDto,
  StatsReadItemDto,
} from "~~/shared/types/api";
import { orderMembers } from "~~/shared/utils/memberOrder";
import { readStateOf } from "~~/shared/utils/readMarks";
import { buildAssemblySlug, formatAssemblyLabel } from "~~/shared/utils/slug";
import type { AssemblyRow } from "./assemblies";
import { loadCoProponentIds } from "./presenters";
import { documentRevision } from "./readMarks";
import { mainAuthorOf } from "./reviewState";

/**
 * Statistics of an assembly for whoever holds `stats:view` (docs/design.md,
 * "Statistics"; the Secretaría and the Presidencia by default): per member and per account, what each read (its read
 * marks), presented, sent, and how it took part in the session. Built from
 * the data the platform already keeps; nothing here writes.
 *
 * Whoever reads them sees the executive offices (canSeeExecutiveMembers
 * lists `stats:view`), so members go out as they are.
 */

/** A published document as the statistics read it. */
interface PublishedDocument {
  id: string;
  slug: string;
  title: string;
  kind: StatsDocumentDto["kind"];
  revision: string;
  /** Main presenter and co-presenters. */
  presenters: string[];
  proponentMemberId: string | null;
}

/** A published amendment as the statistics read it. */
interface PublishedAmendment {
  id: string;
  documentId: string;
  code: string | null;
  revision: string;
  authors: string[];
}

interface Mark {
  revision: string;
  readAt: Date;
}

/** What one account did with one document: document_views summed. */
interface View {
  views: number;
  seconds: number;
  first: Date;
  last: Date;
}

/** Views of one account, by document id. */
type ViewsByDocument = Map<string, View>;

/** Marks of one account, by document or amendment id. */
type MarksByItem = Map<string, Mark>;

const OUTCOME_STATUSES = [
  "submitted",
  "inadmissible",
  "withdrawn",
  "transacted",
  "lapsed",
  "approved",
  "rejected",
] as const satisfies readonly Exclude<AmendmentStatus, "draft">[];

function emptyOutcomes(): StatsAmendmentOutcomes {
  return Object.fromEntries(
    OUTCOME_STATUSES.map((status) => [status, 0]),
  ) as StatsAmendmentOutcomes;
}

function emptyReading(): StatsReadingDto {
  return {
    documents: 0,
    documentsRead: 0,
    documentsChanged: 0,
    amendments: 0,
    amendmentsRead: 0,
    amendmentsChanged: 0,
    lastReadAt: null,
  };
}

/**
 * What an account read, counting only what its member does not present
 * (as the hub counts what is left): pure, for the tests.
 */
export function tallyReading(input: {
  memberId: string | null;
  documents: readonly { id: string; revision: string; presenters: string[] }[];
  amendments: readonly { id: string; revision: string; authors: string[] }[];
  documentMarks: ReadonlyMap<string, Mark> | undefined;
  amendmentMarks: ReadonlyMap<string, Mark> | undefined;
}): StatsReadingDto {
  const reading = emptyReading();
  let last: Date | null = null;
  const own = (ids: string[]) =>
    input.memberId !== null && ids.includes(input.memberId);
  const see = (mark: Mark | undefined) => {
    if (mark && (!last || mark.readAt > last)) last = mark.readAt;
  };

  for (const document of input.documents) {
    const mark = input.documentMarks?.get(document.id);
    see(mark);
    if (own(document.presenters)) continue;
    reading.documents += 1;
    const state = readStateOf(mark?.revision, document.revision);
    if (state === "read") reading.documentsRead += 1;
    if (state === "changed") reading.documentsChanged += 1;
  }
  for (const amendment of input.amendments) {
    const mark = input.amendmentMarks?.get(amendment.id);
    see(mark);
    if (own(amendment.authors)) continue;
    reading.amendments += 1;
    const state = readStateOf(mark?.revision, amendment.revision);
    if (state === "read") reading.amendmentsRead += 1;
    if (state === "changed") reading.amendmentsChanged += 1;
  }
  reading.lastReadAt = last ? (last as Date).toISOString() : null;
  return reading;
}

/**
 * How long an account (or a member, with its accounts' views merged) had
 * the published documents open: pure, for the tests.
 */
export function tallyOpening(input: {
  memberId: string | null;
  documents: readonly { id: string; presenters: string[] }[];
  views: ReadonlyMap<string, View> | undefined;
}): StatsOpeningDto {
  const opening: StatsOpeningDto = {
    documents: 0,
    opened: 0,
    views: 0,
    seconds: 0,
    lastOpenedAt: null,
  };
  let last: Date | null = null;
  for (const document of input.documents) {
    const view = input.views?.get(document.id);
    if (view) {
      opening.views += view.views;
      opening.seconds += view.seconds;
      if (!last || view.last > last) last = view.last;
    }
    if (input.memberId !== null && document.presenters.includes(input.memberId))
      continue;
    opening.documents += 1;
    if (view) opening.opened += 1;
  }
  opening.lastOpenedAt = last ? (last as Date).toISOString() : null;
  return opening;
}

/** Two accounts' views merged, as a member's. */
export function mergeViews(
  into: Map<string, View>,
  views: ReadonlyMap<string, View> | undefined,
): void {
  for (const [documentId, view] of views ?? []) {
    const seen = into.get(documentId);
    into.set(
      documentId,
      seen
        ? {
            views: seen.views + view.views,
            seconds: seen.seconds + view.seconds,
            first: view.first < seen.first ? view.first : seen.first,
            last: view.last > seen.last ? view.last : seen.last,
          }
        : { ...view },
    );
  }
}

/** Whether `a` read more than `b`: documents first, then amendments. */
export function readsMore(a: StatsReadingDto, b: StatsReadingDto): boolean {
  return (
    (a.documentsRead - b.documentsRead ||
      a.amendmentsRead - b.amendmentsRead ||
      a.documentsChanged - b.documentsChanged) > 0
  );
}

async function loadPublished(assemblyId: string): Promise<{
  documents: PublishedDocument[];
  amendments: PublishedAmendment[];
}> {
  const documentRows = await db
    .select({
      id: documents.id,
      slug: documents.slug,
      title: documents.title,
      kind: documents.kind,
      baseVersionId: documents.baseVersionId,
      fileUrl: documents.fileUrl,
      proponentMemberId: documents.proponentMemberId,
    })
    .from(documents)
    .where(
      and(
        eq(documents.assemblyId, assemblyId),
        eq(documents.status, "published"),
      ),
    )
    .orderBy(documents.publishedAt, documents.title);
  const documentIds = documentRows.map((row) => row.id);
  if (documentIds.length === 0) return { documents: [], amendments: [] };

  const [coProponents, amendmentRows] = await Promise.all([
    loadCoProponentIds(documentIds),
    db
      .select({
        id: amendments.id,
        documentId: amendments.documentId,
        code: amendments.code,
        revision: sql<string>`md5(${amendments.ops}::text || '|' || ${amendments.justification})`,
      })
      .from(amendments)
      .where(
        and(
          inArray(amendments.documentId, documentIds),
          ne(amendments.status, "draft"),
          isNotNull(amendments.publishedAt),
        ),
      )
      .orderBy(amendments.documentId, amendments.number),
  ]);
  const authors = await loadAuthors(amendmentRows.map((row) => row.id));

  return {
    documents: documentRows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      revision: documentRevision(row),
      proponentMemberId: row.proponentMemberId,
      presenters: [
        ...(row.proponentMemberId ? [row.proponentMemberId] : []),
        ...(coProponents.get(row.id) ?? []),
      ],
    })),
    amendments: amendmentRows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      code: row.code,
      revision: row.revision,
      authors: authors.get(row.id) ?? [],
    })),
  };
}

async function loadAuthors(
  amendmentIds: string[],
): Promise<Map<string, string[]>> {
  const authors = new Map<string, string[]>();
  if (amendmentIds.length === 0) return authors;
  const rows = await db
    .select({
      amendmentId: amendmentAuthors.amendmentId,
      memberId: amendmentAuthors.memberId,
    })
    .from(amendmentAuthors)
    .where(inArray(amendmentAuthors.amendmentId, amendmentIds));
  for (const row of rows) {
    authors.set(row.amendmentId, [
      ...(authors.get(row.amendmentId) ?? []),
      row.memberId,
    ]);
  }
  return authors;
}

/** Read marks by account, then by document or amendment. */
async function loadMarks(
  published: {
    documents: PublishedDocument[];
    amendments: PublishedAmendment[];
  },
  userId?: string,
): Promise<{
  documents: Map<string, MarksByItem>;
  amendments: Map<string, MarksByItem>;
}> {
  const documentIds = published.documents.map((document) => document.id);
  const amendmentIds = published.amendments.map((amendment) => amendment.id);
  const [documentRows, amendmentRows] = await Promise.all([
    documentIds.length > 0
      ? db
          .select({
            userId: documentReads.userId,
            itemId: documentReads.documentId,
            revision: documentReads.revision,
            readAt: documentReads.readAt,
          })
          .from(documentReads)
          .where(
            and(
              inArray(documentReads.documentId, documentIds),
              userId ? eq(documentReads.userId, userId) : undefined,
            ),
          )
      : [],
    amendmentIds.length > 0
      ? db
          .select({
            userId: amendmentReads.userId,
            itemId: amendmentReads.amendmentId,
            revision: amendmentReads.revision,
            readAt: amendmentReads.readAt,
          })
          .from(amendmentReads)
          .where(
            and(
              inArray(amendmentReads.amendmentId, amendmentIds),
              userId ? eq(amendmentReads.userId, userId) : undefined,
            ),
          )
      : [],
  ]);
  const group = (
    rows: { userId: string; itemId: string; revision: string; readAt: Date }[],
  ) => {
    const byUser = new Map<string, MarksByItem>();
    for (const row of rows) {
      const marks = byUser.get(row.userId) ?? new Map<string, Mark>();
      marks.set(row.itemId, { revision: row.revision, readAt: row.readAt });
      byUser.set(row.userId, marks);
    }
    return byUser;
  };
  return { documents: group(documentRows), amendments: group(amendmentRows) };
}

/** Views of the published documents, by account and then by document. */
async function loadViews(
  published: { documents: PublishedDocument[] },
  userId?: string,
): Promise<Map<string, ViewsByDocument>> {
  const byUser = new Map<string, ViewsByDocument>();
  const documentIds = published.documents.map((document) => document.id);
  if (documentIds.length === 0) return byUser;
  const rows = await db
    .select({
      userId: documentViews.userId,
      documentId: documentViews.documentId,
      views: sum(documentViews.views).mapWith(Number),
      seconds: sum(documentViews.seconds).mapWith(Number),
      first: min(documentViews.firstViewedAt),
      last: max(documentViews.lastViewedAt),
    })
    .from(documentViews)
    .where(
      and(
        inArray(documentViews.documentId, documentIds),
        userId ? eq(documentViews.userId, userId) : undefined,
      ),
    )
    .groupBy(documentViews.userId, documentViews.documentId);
  for (const row of rows) {
    if (!row.first || !row.last) continue;
    const views = byUser.get(row.userId) ?? new Map<string, View>();
    views.set(row.documentId, {
      views: row.views ?? 0,
      seconds: row.seconds ?? 0,
      first: row.first,
      last: row.last,
    });
    byUser.set(row.userId, views);
  }
  return byUser;
}

interface AccountRow {
  id: string;
  name: string;
  image: string | null;
  role: string | null;
  memberId: string | null;
  revoked: boolean;
}

async function loadAccounts(userId?: string): Promise<AccountRow[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      image: users.image,
      role: roles.name,
      memberId: users.memberId,
      accessRevokedAt: users.accessRevokedAt,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(userId ? eq(users.id, userId) : undefined)
    .orderBy(users.name);
  return rows.map(({ accessRevokedAt, ...row }) => ({
    ...row,
    revoked: accessRevokedAt !== null,
  }));
}

/** Sign-ins by account: how many were recorded and the latest. */
async function loadSignIns(
  userId?: string,
): Promise<Map<string, { count: number; last: Date | null }>> {
  const rows = await db
    .select({
      userId: auditLog.actorUserId,
      count: count(),
      last: max(auditLog.createdAt),
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, AUDIT_ACTIONS.AUTH_SIGN_IN),
        isNotNull(auditLog.actorUserId),
        userId ? eq(auditLog.actorUserId, userId) : undefined,
      ),
    )
    .groupBy(auditLog.actorUserId);
  return new Map(
    rows.map((row) => [row.userId!, { count: row.count, last: row.last }]),
  );
}

/** What each account wrote and sent in the assembly. */
async function loadAccountWork(
  assemblyId: string,
  userId?: string,
): Promise<{
  written: Map<string, number>;
  amendmentsSubmitted: Map<string, number>;
  documentsSubmitted: Map<string, number>;
}> {
  const assemblyDocuments = db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.assemblyId, assemblyId));
  const [written, amendmentsSubmitted, documentsSubmitted] = await Promise.all([
    db
      .select({ userId: amendments.createdByUserId, count: count() })
      .from(amendments)
      .where(
        and(
          inArray(amendments.documentId, assemblyDocuments),
          isNotNull(amendments.createdByUserId),
          userId ? eq(amendments.createdByUserId, userId) : undefined,
        ),
      )
      .groupBy(amendments.createdByUserId),
    db
      .select({ userId: amendments.submittedByUserId, count: count() })
      .from(amendments)
      .where(
        and(
          inArray(amendments.documentId, assemblyDocuments),
          isNotNull(amendments.submittedByUserId),
          userId ? eq(amendments.submittedByUserId, userId) : undefined,
        ),
      )
      .groupBy(amendments.submittedByUserId),
    db
      .select({ userId: documents.submittedByUserId, count: count() })
      .from(documents)
      .where(
        and(
          eq(documents.assemblyId, assemblyId),
          isNotNull(documents.submittedByUserId),
          userId ? eq(documents.submittedByUserId, userId) : undefined,
        ),
      )
      .groupBy(documents.submittedByUserId),
  ]);
  const toMap = (rows: { userId: string | null; count: number }[]) =>
    new Map(rows.map((row) => [row.userId!, row.count]));
  return {
    written: toMap(written),
    amendmentsSubmitted: toMap(amendmentsSubmitted),
    documentsSubmitted: toMap(documentsSubmitted),
  };
}

function accountStats(
  account: AccountRow,
  published: {
    documents: PublishedDocument[];
    amendments: PublishedAmendment[];
  },
  marks: Awaited<ReturnType<typeof loadMarks>>,
  signIns: Awaited<ReturnType<typeof loadSignIns>>,
  work: Awaited<ReturnType<typeof loadAccountWork>>,
  views: Map<string, ViewsByDocument>,
): StatsAccountDto {
  const signIn = signIns.get(account.id);
  return {
    ...account,
    online: isOnline(account.id),
    signIns: signIn?.count ?? 0,
    lastSignInAt: signIn?.last ? signIn.last.toISOString() : null,
    reading: tallyReading({
      memberId: account.memberId,
      documents: published.documents,
      amendments: published.amendments,
      documentMarks: marks.documents.get(account.id),
      amendmentMarks: marks.amendments.get(account.id),
    }),
    opening: tallyOpening({
      memberId: account.memberId,
      documents: published.documents,
      views: views.get(account.id),
    }),
    amendmentsWritten: work.written.get(account.id) ?? 0,
    amendmentsSubmitted: work.amendmentsSubmitted.get(account.id) ?? 0,
    documentsSubmitted: work.documentsSubmitted.get(account.id) ?? 0,
  };
}

/** Whether an account counts in the statistics at all. */
function hasActivity(account: StatsAccountDto): boolean {
  return (
    account.reading.lastReadAt !== null ||
    account.opening.lastOpenedAt !== null ||
    account.amendmentsWritten > 0 ||
    account.amendmentsSubmitted > 0 ||
    account.documentsSubmitted > 0
  );
}

/** What members presented and how they took part in the session. */
async function loadMemberWork(assemblyId: string) {
  const presentedDocuments = await db
    .select({
      id: documents.id,
      proponentMemberId: documents.proponentMemberId,
      submittedAt: documents.submittedAt,
      dueAt: documents.dueAt,
    })
    .from(documents)
    .where(
      and(eq(documents.assemblyId, assemblyId), ne(documents.status, "draft")),
    );
  const coProponents = await loadCoProponentIds(
    presentedDocuments.map((row) => row.id),
  );

  const presentedAmendments = await db
    .select({
      id: amendments.id,
      status: amendments.status,
      late: amendments.late,
      meta: amendments.meta,
    })
    .from(amendments)
    .innerJoin(documents, eq(documents.id, amendments.documentId))
    .where(
      and(eq(documents.assemblyId, assemblyId), ne(amendments.status, "draft")),
    );
  const authors = await loadAuthors(presentedAmendments.map((row) => row.id));

  const [counts, entries, turns] = await Promise.all([
    db
      .select({ count: count() })
      .from(headcounts)
      .where(eq(headcounts.assemblyId, assemblyId)),
    db
      .select({
        memberId: headcountEntries.memberId,
        mark: headcountEntries.mark,
        delegateMemberId: headcountEntries.delegateMemberId,
      })
      .from(headcountEntries)
      .innerJoin(headcounts, eq(headcounts.id, headcountEntries.headcountId))
      .where(eq(headcounts.assemblyId, assemblyId)),
    db
      .select({
        memberId: speakingTurns.memberId,
        turns: count(),
        seconds: sql<number>`coalesce(sum(extract(epoch from (coalesce(${speakingTurns.endedAt}, now()) - ${speakingTurns.startedAt}))), 0)::int`,
      })
      .from(speakingTurns)
      .where(
        and(
          eq(speakingTurns.assemblyId, assemblyId),
          inArray(speakingTurns.status, ["done", "speaking"]),
          isNotNull(speakingTurns.memberId),
          isNotNull(speakingTurns.startedAt),
        ),
      )
      .groupBy(speakingTurns.memberId),
  ]);

  return {
    documents: presentedDocuments.map((row) => ({
      presenters: [
        ...(row.proponentMemberId ? [row.proponentMemberId] : []),
        ...(coProponents.get(row.id) ?? []),
      ],
      late: Boolean(
        row.dueAt && row.submittedAt && row.submittedAt > row.dueAt,
      ),
    })),
    amendments: presentedAmendments.map((row) => {
      const authorIds = authors.get(row.id) ?? [];
      const meta = (row.meta ?? {}) as { presentingMemberId?: string };
      return {
        status: row.status as Exclude<AmendmentStatus, "draft">,
        late: row.late,
        authors: authorIds,
        main: mainAuthorOf(authorIds, meta.presentingMemberId),
      };
    }),
    headcountsTaken: counts[0]?.count ?? 0,
    entries,
    turns,
  };
}

/** The statistics of an assembly, per member, per account and per document. */
export async function loadStats(assembly: AssemblyRow): Promise<StatsDto> {
  const published = await loadPublished(assembly.id);
  const [marks, accountRows, signIns, work, memberWork, memberRows] =
    await Promise.all([
      loadMarks(published),
      loadAccounts(),
      loadSignIns(),
      loadAccountWork(assembly.id),
      loadMemberWork(assembly.id),
      db
        .select({
          id: members.id,
          acronym: members.acronym,
          name: members.name,
          kind: members.kind,
          university: members.university,
          active: members.active,
        })
        .from(members),
    ]);

  const views = await loadViews(published);
  const accounts = accountRows.map((account) =>
    accountStats(account, published, marks, signIns, work, views),
  );

  // Members -------------------------------------------------------------
  const byMember = new Map<string, StatsMemberDto>();
  for (const row of memberRows) {
    byMember.set(row.id, {
      member: row,
      accounts: 0,
      documentsPresented: 0,
      documentsLate: 0,
      amendmentsPresented: 0,
      amendmentsMain: 0,
      amendmentsLate: 0,
      amendmentOutcomes: emptyOutcomes(),
      // What it has to read, with nothing read: a member without an
      // account, or whose accounts marked nothing, shows "0 of n".
      reading: tallyReading({
        memberId: row.id,
        documents: published.documents,
        amendments: published.amendments,
        documentMarks: undefined,
        amendmentMarks: undefined,
      }),
      opening: tallyOpening({
        memberId: row.id,
        documents: published.documents,
        views: undefined,
      }),
      headcounts: {
        taken: memberWork.headcountsTaken,
        inRoom: 0,
        delegated: 0,
        received: 0,
      },
      speakingTurns: 0,
      speakingSeconds: 0,
    });
  }
  const memberViews = new Map<string, Map<string, View>>();
  for (const account of accounts) {
    const stats = account.memberId ? byMember.get(account.memberId) : null;
    if (!stats || !account.memberId) continue;
    stats.accounts += 1;
    const merged = memberViews.get(account.memberId) ?? new Map<string, View>();
    mergeViews(merged, views.get(account.id));
    memberViews.set(account.memberId, merged);
    if (readsMore(account.reading, stats.reading)) {
      stats.reading = account.reading;
    } else if (
      account.reading.lastReadAt &&
      (!stats.reading.lastReadAt ||
        account.reading.lastReadAt > stats.reading.lastReadAt)
    ) {
      stats.reading = {
        ...stats.reading,
        lastReadAt: account.reading.lastReadAt,
      };
    }
  }
  for (const [memberId, merged] of memberViews) {
    const stats = byMember.get(memberId);
    if (stats) {
      stats.opening = tallyOpening({
        memberId,
        documents: published.documents,
        views: merged,
      });
    }
  }
  for (const document of memberWork.documents) {
    for (const memberId of new Set(document.presenters)) {
      const stats = byMember.get(memberId);
      if (!stats) continue;
      stats.documentsPresented += 1;
      if (document.late) stats.documentsLate += 1;
    }
  }
  for (const amendment of memberWork.amendments) {
    for (const memberId of new Set(amendment.authors)) {
      const stats = byMember.get(memberId);
      if (!stats) continue;
      stats.amendmentsPresented += 1;
      if (amendment.main === memberId) stats.amendmentsMain += 1;
      if (amendment.late) stats.amendmentsLate += 1;
      stats.amendmentOutcomes[amendment.status] += 1;
    }
  }
  for (const entry of memberWork.entries) {
    const stats = byMember.get(entry.memberId);
    if (stats && entry.mark === "present") stats.headcounts.inRoom += 1;
    if (stats && entry.mark === "delegated") stats.headcounts.delegated += 1;
    const receiver = entry.delegateMemberId
      ? byMember.get(entry.delegateMemberId)
      : null;
    if (receiver && entry.mark === "delegated")
      receiver.headcounts.received += 1;
  }
  for (const turn of memberWork.turns) {
    const stats = turn.memberId ? byMember.get(turn.memberId) : null;
    if (!stats) continue;
    stats.speakingTurns = turn.turns;
    stats.speakingSeconds = Number(turn.seconds);
  }
  // Every active asociado and sectorial, and any other member that did
  // something: an inactive one, an office, the CAS.
  const memberStats = orderMembers(
    [...byMember.values()].map((stats) => ({
      ...stats,
      kind: stats.member.kind,
      acronym: stats.member.acronym,
      active: stats.member.active,
    })),
  )
    .filter(
      (stats) =>
        (stats.member.active &&
          (stats.member.kind === "asociado" ||
            stats.member.kind === "sectorial")) ||
        stats.accounts > 0 ||
        stats.documentsPresented > 0 ||
        stats.amendmentsPresented > 0 ||
        stats.headcounts.inRoom + stats.headcounts.delegated > 0 ||
        stats.speakingTurns > 0,
    )
    .map(
      ({ kind: _kind, acronym: _acronym, active: _active, ...stats }) => stats,
    );

  // Documents -----------------------------------------------------------
  const accountMember = new Map(
    accounts.map((account) => [account.id, account.memberId]),
  );
  const amendmentCount = new Map<string, number>();
  for (const amendment of published.amendments) {
    amendmentCount.set(
      amendment.documentId,
      (amendmentCount.get(amendment.documentId) ?? 0) + 1,
    );
  }
  const memberRef = (id: string | null): MemberRef | null => {
    const row = id ? byMember.get(id)?.member : null;
    return row
      ? { id: row.id, acronym: row.acronym, name: row.name, kind: row.kind }
      : null;
  };
  const documentStats: StatsDocumentDto[] = published.documents.map(
    (document) => {
      let readers = 0;
      let changed = 0;
      const readerMembers = new Set<string>();
      for (const [userId, userMarks] of marks.documents) {
        const mark = userMarks.get(document.id);
        if (!mark) continue;
        if (mark.revision === document.revision) {
          readers += 1;
          const memberId = accountMember.get(userId);
          if (memberId) readerMembers.add(memberId);
        } else {
          changed += 1;
        }
      }
      let openedBy = 0;
      let documentViewCount = 0;
      let seconds = 0;
      const openedByMembers = new Set<string>();
      for (const [userId, userViews] of views) {
        const view = userViews.get(document.id);
        if (!view) continue;
        openedBy += 1;
        documentViewCount += view.views;
        seconds += view.seconds;
        const memberId = accountMember.get(userId);
        if (memberId) openedByMembers.add(memberId);
      }
      return {
        id: document.id,
        slug: document.slug,
        title: document.title,
        kind: document.kind,
        presenter: memberRef(document.proponentMemberId),
        readers,
        readerMembers: readerMembers.size,
        changed,
        amendments: amendmentCount.get(document.id) ?? 0,
        openedBy,
        openedByMembers: openedByMembers.size,
        views: documentViewCount,
        seconds,
      };
    },
  );

  const listed = accounts.filter(
    (account) => account.memberId !== null || hasActivity(account),
  );

  return {
    assembly: {
      id: assembly.id,
      slug: buildAssemblySlug(assembly),
      label: formatAssemblyLabel(assembly),
    },
    totals: {
      documents: published.documents.length,
      amendments: published.amendments.length,
      accounts: listed.length,
      readingAccounts: listed.filter(
        (account) => account.reading.lastReadAt !== null,
      ).length,
      readingMembers: memberStats.filter(
        (stats) => stats.reading.lastReadAt !== null,
      ).length,
      openingAccounts: listed.filter(
        (account) => account.opening.lastOpenedAt !== null,
      ).length,
    },
    members: memberStats,
    accounts: listed,
    documents: documentStats,
  };
}

/** One account's statistics in an assembly, with each of its marks. */
export async function loadAccountStats(
  assembly: AssemblyRow,
  userId: string,
): Promise<StatsAccountDetailDto | null> {
  const [account] = await loadAccounts(userId);
  if (!account) return null;
  const published = await loadPublished(assembly.id);
  const [marks, signIns, work, views] = await Promise.all([
    loadMarks(published, userId),
    loadSignIns(userId),
    loadAccountWork(assembly.id, userId),
    loadViews(published, userId),
  ]);
  const accountViews = views.get(userId);
  const member = account.memberId
    ? await db.query.members.findFirst({
        columns: { id: true, acronym: true, name: true, kind: true },
        where: eq(members.id, account.memberId),
      })
    : null;

  const documentMarks = marks.documents.get(userId);
  const amendmentMarks = marks.amendments.get(userId);
  const own = (ids: string[]) =>
    account.memberId !== null && ids.includes(account.memberId);
  const item = (
    mark: Mark | undefined,
    revision: string,
  ): { state: ReadState; readAt: string | null } => ({
    state: readStateOf(mark?.revision, revision),
    readAt: mark ? mark.readAt.toISOString() : null,
  });
  const documentsById = new Map(
    published.documents.map((document) => [document.id, document]),
  );

  return {
    account: accountStats(account, published, marks, signIns, work, views),
    member: member ?? null,
    documents: published.documents.map((document): StatsReadItemDto => ({
      id: document.id,
      label: document.title,
      documentTitle: null,
      slug: document.slug,
      own: own(document.presenters),
      ...item(documentMarks?.get(document.id), document.revision),
      views: accountViews?.get(document.id)?.views ?? 0,
      seconds: accountViews?.get(document.id)?.seconds ?? 0,
      firstOpenedAt:
        accountViews?.get(document.id)?.first.toISOString() ?? null,
    })),
    amendments: published.amendments.map((amendment): StatsReadItemDto => {
      const document = documentsById.get(amendment.documentId);
      return {
        id: amendment.id,
        label: amendment.code ?? "",
        documentTitle: document?.title ?? null,
        slug: document?.slug ?? "",
        own: own(amendment.authors),
        ...item(amendmentMarks?.get(amendment.id), amendment.revision),
        views: 0,
        seconds: 0,
        firstOpenedAt: null,
      };
    }),
  };
}

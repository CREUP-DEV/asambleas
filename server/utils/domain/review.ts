import { createError } from "h3";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
} from "drizzle-orm";
import { db } from "../../db";
import {
  amendmentAcceptances,
  amendmentAuthors,
  amendments,
  assemblies,
  documents,
} from "../../db/schema";
import type { DocumentStatus } from "~~/shared/constants/domain";
import type {
  MeWorkAcceptanceDto,
  MeWorkAmendmentDto,
  MeWorkAssemblyRef,
  MeWorkDocumentDto,
  MeWorkDto,
  MeWorkProponentDto,
  MeWorkReviewDto,
  ReviewQueueAmendmentDto,
  ReviewQueueDto,
} from "~~/shared/types/api";
import { buildAssemblySlug, formatAssemblyLabel } from "~~/shared/utils/slug";
import { canManageDocuments, canReviewAmendments, type Actor } from "./actor";
import {
  buildAmendmentDtos,
  buildDocumentAmendmentContext,
  canSeeLoadedAmendment,
  findAmendmentsAwaitingReview,
  findSubmittedAmendments,
  findTransactionalsAwaitingMember,
  loadedMainAuthor,
  membersSourcesOf,
} from "./amendments";
import { loadAgendaItems, visibleDocumentsCondition } from "./assemblies";
import {
  assemblySettings,
  buildDocumentSummaries,
  loadMilestones,
  loadMilestonesByAssembly,
} from "./documents";
import { loadWorkNews } from "./news";
import {
  coPresentedBy,
  loadCoProponentIds,
  withCoProponentIds,
} from "./presenters";
import {
  SETTLED_PRIVATE_STATUSES,
  agendaPositions,
  amendmentReviewState,
  authorsApproval,
  countPositionsPending,
  hasPendingReview,
  type ReviewCounts,
} from "./reviewState";
import {
  canSeeAssembly,
  canSeeDocument,
  redactMemberOrNull,
} from "./visibility";

/**
 * The Secretaría's validation inbox (GET .../review) and each user's work on
 * the home page (GET /api/me/work). docs/api.md, "Review and work".
 */

type AssemblyRow = typeof assemblies.$inferSelect;

/** Statuses a presenter still works on or follows: not withdrawn nor postponed. */
const WORK_DOCUMENT_STATUSES: DocumentStatus[] = [
  "draft",
  "submitted",
  "published",
];

/** Amendments past these statuses are decided and leave the home page. */
const OPEN_AMENDMENT_STATUSES = ["draft", "submitted"] as const;

export function canUseReviewQueue(actor: Actor): boolean {
  return canManageDocuments(actor) || canReviewAmendments(actor);
}

function assemblyRef(assembly: AssemblyRow): MeWorkAssemblyRef {
  return {
    id: assembly.id,
    slug: buildAssemblySlug(assembly),
    label: formatAssemblyLabel(assembly),
  };
}

// Validation inbox ---------------------------------------------------------------

/**
 * What waits for the Secretaría in one assembly (document:manage or
 * amendment:review): presented documents to validate, for document:manage,
 * and, for amendment:review, amendments to validate or publish, late ones
 * waiting for the assembly's decision and, read only, member-proposed
 * transactionals waiting for their main authors
 * (findAmendmentsAwaitingReview), grouped by document in agenda order (then
 * creation order) and then in text order.
 */
export async function loadReviewQueue(
  actor: Actor,
  assembly: AssemblyRow,
): Promise<ReviewQueueDto> {
  const manageDocuments = canManageDocuments(actor);
  const reviewAmendments = canReviewAmendments(actor);
  if (!manageDocuments && !reviewAmendments) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para revisar la documentación",
    });
  }

  const [rows, milestones, items] = await Promise.all([
    db.query.documents
      .findMany({
        where: eq(documents.assemblyId, assembly.id),
        with: { proponent: true },
        orderBy: (table, { asc: ascending }) => [
          ascending(table.createdAt),
          ascending(table.id),
        ],
      })
      .then((list) => withCoProponentIds(list)),
    loadMilestones(assembly.id),
    loadAgendaItems(assembly.id),
  ]);
  // The Secretaría reviews in the order the assembly will debate.
  const position = agendaPositions(items);
  const visible = rows
    .filter((row) => canSeeDocument(actor, row))
    .sort(
      (a, b) =>
        (position.get(a.agendaItemId) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.agendaItemId) ?? Number.MAX_SAFE_INTEGER),
    );
  const now = new Date();

  const documentDtos = manageDocuments
    ? await buildDocumentSummaries(
        actor,
        visible.filter((row) => row.status === "submitted"),
        new Map([[assembly.id, milestones]]),
        now,
      )
    : [];

  const amendmentDtos: ReviewQueueAmendmentDto[] = [];
  if (reviewAmendments) {
    const pending = await findAmendmentsAwaitingReview(visible);
    for (const document of visible) {
      const own = pending.filter((row) => row.documentId === document.id);
      if (own.length === 0) continue;
      const ctx = buildDocumentAmendmentContext(
        actor,
        assembly,
        document,
        milestones,
        now,
      );
      const ref = {
        id: document.id,
        slug: document.slug,
        title: document.title,
        reference: document.reference,
      };
      for (const amendment of await buildAmendmentDtos(ctx, own)) {
        amendmentDtos.push({ document: ref, amendment });
      }
    }
  }

  return { documents: documentDtos, amendments: amendmentDtos };
}

// Home page -----------------------------------------------------------------------

/** Assemblies that are not closed and that the actor can see, soonest first. */
async function loadWorkAssemblies(actor: Actor): Promise<AssemblyRow[]> {
  const rows = await db
    .select()
    .from(assemblies)
    .where(ne(assemblies.status, "closed"))
    .orderBy(asc(assemblies.startDate), asc(assemblies.id));
  return rows.filter((row) => canSeeAssembly(actor, row));
}

/** Rows sorted by the order of their assembly in `assemblyRows`. */
function byAssemblyOrder<T extends { assembly: MeWorkAssemblyRef }>(
  rows: T[],
  assemblyRows: AssemblyRow[],
): T[] {
  const order = assemblyRows.map((row) => row.id);
  return rows.sort(
    (a, b) => order.indexOf(a.assembly.id) - order.indexOf(b.assembly.id),
  );
}

/**
 * Documents the actor's member presents, as main presenter or co-presenter,
 * with where each one stands.
 */
async function loadWorkDocuments(
  actor: Actor,
  assemblyRows: AssemblyRow[],
): Promise<MeWorkDocumentDto[]> {
  if (!actor.memberId || assemblyRows.length === 0) return [];
  const byId = new Map(assemblyRows.map((row) => [row.id, row]));
  const rows = await db.query.documents.findMany({
    where: and(
      inArray(documents.assemblyId, [...byId.keys()]),
      or(
        eq(documents.proponentMemberId, actor.memberId),
        coPresentedBy(actor.memberId),
      ),
      inArray(documents.status, WORK_DOCUMENT_STATUSES),
    ),
    with: { proponent: true },
    orderBy: (table, { asc: ascending }) => [
      ascending(table.createdAt),
      ascending(table.id),
    ],
  });
  const visible = (await withCoProponentIds(rows)).filter((row) =>
    canSeeDocument(actor, row),
  );
  const summaries = await buildDocumentSummaries(
    actor,
    visible,
    await loadMilestonesByAssembly([...byId.keys()]),
  );
  return byAssemblyOrder(
    visible.map((row, index) => ({
      assembly: assemblyRef(byId.get(row.assemblyId)!),
      document: summaries[index]!,
    })),
    assemblyRows,
  );
}

/** Amendments the actor's member wrote that are not decided yet, newest change first. */
async function loadWorkAmendments(
  actor: Actor,
  assemblyRows: AssemblyRow[],
): Promise<MeWorkAmendmentDto[]> {
  if (!actor.memberId || assemblyRows.length === 0) return [];
  const byId = new Map(assemblyRows.map((row) => [row.id, row]));
  const rows = await db
    .select({
      id: amendments.id,
      kind: amendments.kind,
      code: amendments.code,
      status: amendments.status,
      late: amendments.late,
      admission: amendments.admission,
      validatedAt: amendments.validatedAt,
      publishedAt: amendments.publishedAt,
      correctionNote: amendments.correctionNote,
      correctionRequestedAt: amendments.correctionRequestedAt,
      updatedAt: amendments.updatedAt,
      documentId: documents.id,
      documentSlug: documents.slug,
      documentTitle: documents.title,
      documentStatus: documents.status,
      proponentMemberId: documents.proponentMemberId,
      submittedByUserId: documents.submittedByUserId,
      assemblyId: documents.assemblyId,
    })
    .from(amendments)
    .innerJoin(
      amendmentAuthors,
      eq(amendmentAuthors.amendmentId, amendments.id),
    )
    .innerJoin(documents, eq(documents.id, amendments.documentId))
    .where(
      and(
        eq(amendmentAuthors.memberId, actor.memberId),
        inArray(amendments.status, [...OPEN_AMENDMENT_STATUSES]),
        inArray(documents.assemblyId, [...byId.keys()]),
      ),
    )
    .orderBy(desc(amendments.updatedAt), asc(amendments.id));

  // A transactional waits for its main authors before the Secretaría.
  const transactionalIds = rows
    .filter((row) => row.kind === "transactional")
    .map((row) => row.id);
  const [acceptanceRows, coProponents] = await Promise.all([
    transactionalIds.length > 0
      ? db
          .select({
            amendmentId: amendmentAcceptances.amendmentId,
            role: amendmentAcceptances.role,
            decision: amendmentAcceptances.decision,
          })
          .from(amendmentAcceptances)
          .where(inArray(amendmentAcceptances.amendmentId, transactionalIds))
      : Promise.resolve([]),
    loadCoProponentIds([...new Set(rows.map((row) => row.documentId))]),
  ]);

  return rows
    .filter((row) =>
      canSeeDocument(actor, {
        status: row.documentStatus,
        proponentMemberId: row.proponentMemberId,
        coProponentMemberIds: coProponents.get(row.documentId) ?? [],
        submittedByUserId: row.submittedByUserId,
      }),
    )
    .map((row) => ({
      assembly: assemblyRef(byId.get(row.assemblyId)!),
      document: {
        id: row.documentId,
        slug: row.documentSlug,
        title: row.documentTitle,
      },
      amendment: {
        id: row.id,
        code: row.code,
        status: row.status,
        reviewState: amendmentReviewState({
          ...row,
          authorsApproval: authorsApproval({
            kind: row.kind,
            acceptances: acceptanceRows.filter(
              (acceptance) => acceptance.amendmentId === row.id,
            ),
          }),
        }),
        // The actor's member wrote it: the note is for them.
        correctionNote: row.correctionNote,
        late: row.late,
        admission: row.admission,
        updatedAt: row.updatedAt.toISOString(),
      },
    }));
}

/** Per assembly counts of `rows` grouped by assemblyId. */
function countsByAssembly(
  rows: { assemblyId: string; total: number }[],
): Map<string, number> {
  return new Map(rows.map((row) => [row.assemblyId, Number(row.total)]));
}

/**
 * For the Secretaría: per assembly, what waits for it. Document counts need
 * document:manage and amendment counts need amendment:review; only
 * assemblies with something pending are listed. The amendment counts match
 * the inbox's "to validate" and "to publish" sections: transactionals
 * waiting for their main authors and late amendments waiting for the
 * assembly wait for someone else, so they are not counted.
 */
async function loadWorkReview(
  actor: Actor,
  assemblyRows: AssemblyRow[],
  now: Date,
): Promise<MeWorkReviewDto[]> {
  const manageDocuments = canManageDocuments(actor);
  const reviewAmendments = canReviewAmendments(actor);
  if ((!manageDocuments && !reviewAmendments) || assemblyRows.length === 0)
    return [];
  const ids = assemblyRows.map((row) => row.id);
  const inAssemblies = inArray(documents.assemblyId, ids);
  const empty = Promise.resolve([] as { assemblyId: string; total: number }[]);

  const documentCount = (condition: ReturnType<typeof and>) =>
    db
      .select({ assemblyId: documents.assemblyId, total: count() })
      .from(documents)
      .where(and(inAssemblies, condition))
      .groupBy(documents.assemblyId);
  const amendmentCount = (condition: ReturnType<typeof and>) =>
    db
      .select({ assemblyId: documents.assemblyId, total: count() })
      .from(amendments)
      .innerJoin(documents, eq(documents.id, amendments.documentId))
      .where(and(inAssemblies, visibleDocumentsCondition(actor), condition))
      .groupBy(documents.assemblyId);

  const [toValidate, overdue, amendmentsToValidate, amendmentsToPublish] =
    await Promise.all([
      manageDocuments
        ? documentCount(eq(documents.status, "submitted"))
        : empty,
      manageDocuments
        ? documentCount(
            and(
              eq(documents.status, "draft"),
              isNotNull(documents.dueAt),
              lt(documents.dueAt, now),
            ),
          )
        : empty,
      reviewAmendments
        ? amendmentCount(
            and(
              eq(amendments.status, "submitted"),
              isNull(amendments.validatedAt),
              // Not a transactional still waiting for its main authors
              // (awaitsAuthors): they answer first.
              notExists(
                db
                  .select({ id: amendmentAcceptances.id })
                  .from(amendmentAcceptances)
                  .where(
                    and(
                      eq(amendmentAcceptances.amendmentId, amendments.id),
                      eq(amendmentAcceptances.role, "author"),
                      ne(amendmentAcceptances.decision, "accepted"),
                    ),
                  ),
              ),
            ),
          )
        : empty,
      reviewAmendments
        ? amendmentCount(
            and(
              isNotNull(amendments.validatedAt),
              isNull(amendments.publishedAt),
              notInArray(amendments.status, [...SETTLED_PRIVATE_STATUSES]),
              // Not a late one waiting for the assembly's decision
              // (awaitsAssemblyDecision): the inbox lists it with the late
              // ones, and treating it publishes it. The three columns are
              // not null, so this is exactly its negation.
              or(
                eq(amendments.late, false),
                ne(amendments.admission, "pending"),
                ne(amendments.status, "submitted"),
              ),
            ),
          )
        : empty,
    ]);

  const maps = {
    documentsToValidate: countsByAssembly(toValidate),
    documentsOverdue: countsByAssembly(overdue),
    amendmentsToValidate: countsByAssembly(amendmentsToValidate),
    amendmentsToPublish: countsByAssembly(amendmentsToPublish),
  };
  const result: MeWorkReviewDto[] = [];
  for (const assembly of assemblyRows) {
    const counts: ReviewCounts = {
      documentsToValidate: maps.documentsToValidate.get(assembly.id) ?? 0,
      amendmentsToValidate: maps.amendmentsToValidate.get(assembly.id) ?? 0,
      amendmentsToPublish: maps.amendmentsToPublish.get(assembly.id) ?? 0,
      documentsOverdue: maps.documentsOverdue.get(assembly.id) ?? 0,
    };
    if (hasPendingReview(counts)) {
      result.push({ assembly: assemblyRef(assembly), ...counts });
    }
  }
  return result;
}

/** Published documents of these assemblies with no final vote yet. */
function openPublishedDocuments(assemblyIds: string[]) {
  return and(
    inArray(documents.assemblyId, assemblyIds),
    eq(documents.status, "published"),
    isNull(documents.finalVoteId),
    isNull(documents.consolidatedVersionId),
  );
}

/**
 * For the main presenter: published documents its member presents as main
 * presenter, not voted yet, with amendments it can answer now
 * (countPositionsPending over the amendments the actor can see). Documents
 * with nothing to answer are left out.
 */
async function loadWorkProponent(
  actor: Actor,
  assemblyRows: AssemblyRow[],
): Promise<MeWorkProponentDto[]> {
  if (!actor.memberId || assemblyRows.length === 0) return [];
  const byId = new Map(assemblyRows.map((row) => [row.id, row]));
  const rows = await db
    .select({
      id: documents.id,
      slug: documents.slug,
      title: documents.title,
      assemblyId: documents.assemblyId,
      acceptedAmendments: documents.acceptedAmendments,
    })
    .from(documents)
    .where(
      and(
        openPublishedDocuments([...byId.keys()]),
        eq(documents.proponentMemberId, actor.memberId),
      ),
    )
    .orderBy(asc(documents.createdAt), asc(documents.id));
  if (rows.length === 0) return [];

  const submitted = (
    await findSubmittedAmendments(rows.map((row) => row.id))
  ).filter((row) => canSeeLoadedAmendment(actor, row));
  const result: MeWorkProponentDto[] = [];
  for (const row of rows) {
    const positionsPending = countPositionsPending(
      submitted
        .filter((amendment) => amendment.documentId === row.id)
        .map((amendment) => ({
          status: amendment.status,
          admission: amendment.admission,
          validatedAt: amendment.validatedAt,
          publishedAt: amendment.publishedAt,
          approvalMethod: amendment.approvalMethod,
          authorsApproval: authorsApproval(amendment),
          position: amendment.position?.position ?? null,
        })),
      row.acceptedAmendments,
    );
    if (positionsPending === 0) continue;
    result.push({
      assembly: assemblyRef(byId.get(row.assemblyId)!),
      document: { id: row.id, slug: row.slug, title: row.title },
      positionsPending,
    });
  }
  return byAssemblyOrder(result, assemblyRows);
}

/**
 * Transactionals waiting for the actor's member to accept or reject them:
 * it is the main author of an amendment they would replace and has not
 * answered yet. With the amendments of the member each one replaces.
 */
async function loadWorkAcceptances(
  actor: Actor,
  assemblyRows: AssemblyRow[],
): Promise<MeWorkAcceptanceDto[]> {
  if (!actor.memberId || assemblyRows.length === 0) return [];
  const byId = new Map(assemblyRows.map((row) => [row.id, row]));
  const documentRows = await db
    .select({
      id: documents.id,
      slug: documents.slug,
      title: documents.title,
      assemblyId: documents.assemblyId,
    })
    .from(documents)
    .where(openPublishedDocuments([...byId.keys()]))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  const transactionals = (
    await findTransactionalsAwaitingMember(
      documentRows.map((row) => row.id),
      actor.memberId,
    )
  ).filter((row) => canSeeLoadedAmendment(actor, row));
  if (transactionals.length === 0) return [];
  const replaces = await membersSourcesOf(transactionals, actor.memberId);

  const result: MeWorkAcceptanceDto[] = [];
  for (const document of documentRows) {
    for (const transactional of transactionals) {
      if (transactional.documentId !== document.id) continue;
      result.push({
        assembly: assemblyRef(byId.get(document.assemblyId)!),
        document: {
          id: document.id,
          slug: document.slug,
          title: document.title,
        },
        transactional: { id: transactional.id, code: transactional.code },
        // An executive area reads as "CEA" to whoever may not see the areas.
        proposedBy: redactMemberOrNull(
          actor,
          transactional.authors.find(
            (author) => author.memberId === loadedMainAuthor(transactional),
          )?.member,
        ),
        replaces: replaces.get(transactional.id) ?? [],
      });
    }
  }
  return byAssemblyOrder(result, assemblyRows);
}

/**
 * GET /api/me/work: across the assemblies that are not closed and that the
 * actor can see, the documents their member presents, the amendments it
 * wrote that are not decided yet, what it has to answer as main presenter
 * and as main author, what others decided about its work and, for the
 * Secretaría, what waits for it.
 */
export async function loadMeWork(actor: Actor): Promise<MeWorkDto> {
  const assemblyRows = await loadWorkAssemblies(actor);
  const now = new Date();
  const [workDocuments, workAmendments, review, proponent, acceptances, news] =
    await Promise.all([
      loadWorkDocuments(actor, assemblyRows),
      loadWorkAmendments(actor, assemblyRows),
      loadWorkReview(actor, assemblyRows, now),
      loadWorkProponent(actor, assemblyRows),
      loadWorkAcceptances(actor, assemblyRows),
      loadWorkNews(
        actor,
        assemblyRows.map((row) => ({
          ref: assemblyRef(row),
          settings: assemblySettings(row),
          status: row.status,
        })),
        now,
      ),
    ]);
  return {
    documents: workDocuments,
    amendments: workAmendments,
    review,
    proponent,
    acceptances,
    news,
  };
}

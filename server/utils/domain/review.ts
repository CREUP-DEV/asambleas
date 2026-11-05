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
} from "./amendments";
import { loadAgendaItems, visibleDocumentsCondition } from "./assemblies";
import {
  buildDocumentSummaries,
  loadMilestones,
  loadMilestonesByAssembly,
} from "./documents";
import {
  SETTLED_PRIVATE_STATUSES,
  agendaPositions,
  amendmentReviewState,
  countProponentWork,
  hasPendingReview,
  proponentApproval,
  type ReviewCounts,
} from "./reviewState";
import { canSeeAssembly, canSeeDocument } from "./visibility";

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
 * transactionals waiting for the document's presenter
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
    db.query.documents.findMany({
      where: eq(documents.assemblyId, assembly.id),
      with: { proponent: true },
      orderBy: (table, { asc: ascending }) => [
        ascending(table.createdAt),
        ascending(table.id),
      ],
    }),
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

/** Documents the actor's member presents, with where each one stands. */
async function loadWorkDocuments(
  actor: Actor,
  assemblyRows: AssemblyRow[],
): Promise<MeWorkDocumentDto[]> {
  if (!actor.memberId || assemblyRows.length === 0) return [];
  const byId = new Map(assemblyRows.map((row) => [row.id, row]));
  const rows = await db.query.documents.findMany({
    where: and(
      inArray(documents.assemblyId, [...byId.keys()]),
      eq(documents.proponentMemberId, actor.memberId),
      inArray(documents.status, WORK_DOCUMENT_STATUSES),
    ),
    with: { proponent: true },
    orderBy: (table, { asc: ascending }) => [
      ascending(table.createdAt),
      ascending(table.id),
    ],
  });
  const visible = rows.filter((row) => canSeeDocument(actor, row));
  const summaries = await buildDocumentSummaries(
    actor,
    visible,
    await loadMilestonesByAssembly([...byId.keys()]),
  );
  const order = assemblyRows.map((row) => row.id);
  return visible
    .map((row, index) => ({
      assembly: assemblyRef(byId.get(row.assemblyId)!),
      document: summaries[index]!,
    }))
    .sort(
      (a, b) => order.indexOf(a.assembly.id) - order.indexOf(b.assembly.id),
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

  // A transactional waits for its document's presenter before the Secretaría.
  const transactionalIds = rows
    .filter((row) => row.kind === "transactional")
    .map((row) => row.id);
  const acceptanceRows =
    transactionalIds.length > 0
      ? await db
          .select({
            amendmentId: amendmentAcceptances.amendmentId,
            memberId: amendmentAcceptances.memberId,
            decision: amendmentAcceptances.decision,
          })
          .from(amendmentAcceptances)
          .where(inArray(amendmentAcceptances.amendmentId, transactionalIds))
      : [];

  return rows
    .filter((row) =>
      canSeeDocument(actor, {
        status: row.documentStatus,
        proponentMemberId: row.proponentMemberId,
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
          proponentApproval: proponentApproval(
            {
              kind: row.kind,
              acceptances: acceptanceRows.filter(
                (acceptance) => acceptance.amendmentId === row.id,
              ),
            },
            row.proponentMemberId,
          ),
        }),
        // The actor's member wrote it: the note is for them.
        correctionNote: row.correctionNote,
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
 * waiting for the presenter and late amendments waiting for the assembly
 * wait for someone else, so they are not counted.
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
              // Not a transactional still waiting for the document's
              // presenter (awaitsProponent): the presenter answers first.
              notExists(
                db
                  .select({ id: amendmentAcceptances.id })
                  .from(amendmentAcceptances)
                  .where(
                    and(
                      eq(amendmentAcceptances.amendmentId, amendments.id),
                      eq(
                        amendmentAcceptances.memberId,
                        documents.proponentMemberId,
                      ),
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

/**
 * For the presenter: published documents its member presents, not voted yet,
 * with amendments to answer (countProponentWork over the amendments the
 * actor can see). Documents with nothing to answer are left out.
 */
async function loadWorkProponent(
  actor: Actor,
  assemblyRows: AssemblyRow[],
): Promise<MeWorkProponentDto[]> {
  if (!actor.memberId || assemblyRows.length === 0) return [];
  const memberId = actor.memberId;
  const byId = new Map(assemblyRows.map((row) => [row.id, row]));
  const rows = await db
    .select({
      id: documents.id,
      slug: documents.slug,
      title: documents.title,
      assemblyId: documents.assemblyId,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.assemblyId, [...byId.keys()]),
        eq(documents.proponentMemberId, memberId),
        eq(documents.status, "published"),
        isNull(documents.finalVoteId),
        isNull(documents.consolidatedVersionId),
      ),
    )
    .orderBy(asc(documents.createdAt), asc(documents.id));
  if (rows.length === 0) return [];

  const submitted = (
    await findSubmittedAmendments(rows.map((row) => row.id))
  ).filter((row) => canSeeLoadedAmendment(actor, row));
  const order = assemblyRows.map((row) => row.id);
  const result: MeWorkProponentDto[] = [];
  for (const row of rows) {
    const counts = countProponentWork(
      submitted
        .filter((amendment) => amendment.documentId === row.id)
        .map((amendment) => ({
          kind: amendment.kind,
          status: amendment.status,
          validatedAt: amendment.validatedAt,
          publishedAt: amendment.publishedAt,
          position: amendment.position?.position ?? null,
          acceptances: amendment.acceptances,
        })),
      memberId,
    );
    if (counts.positionsPending + counts.transactionalsToApprove === 0) {
      continue;
    }
    result.push({
      assembly: assemblyRef(byId.get(row.assemblyId)!),
      document: { id: row.id, slug: row.slug, title: row.title },
      ...counts,
    });
  }
  return result.sort(
    (a, b) => order.indexOf(a.assembly.id) - order.indexOf(b.assembly.id),
  );
}

/**
 * GET /api/me/work: across the assemblies that are not closed and that the
 * actor can see, the documents their member presents, the amendments it
 * wrote that are not decided yet, what it has to answer as a presenter and,
 * for the Secretaría, what waits for it.
 */
export async function loadMeWork(actor: Actor): Promise<MeWorkDto> {
  const assemblyRows = await loadWorkAssemblies(actor);
  const now = new Date();
  const [workDocuments, workAmendments, review, proponent] = await Promise.all([
    loadWorkDocuments(actor, assemblyRows),
    loadWorkAmendments(actor, assemblyRows),
    loadWorkReview(actor, assemblyRows, now),
    loadWorkProponent(actor, assemblyRows),
  ]);
  return {
    documents: workDocuments,
    amendments: workAmendments,
    review,
    proponent,
  };
}

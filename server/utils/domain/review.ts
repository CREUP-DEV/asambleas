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
  notInArray,
} from "drizzle-orm";
import { db } from "../../db";
import {
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
  MeWorkReviewDto,
  ReviewQueueAmendmentDto,
  ReviewQueueDto,
} from "~~/shared/types/api";
import { buildAssemblySlug, formatAssemblyLabel } from "~~/shared/utils/slug";
import { canManageDocuments, canReviewAmendments, type Actor } from "./actor";
import {
  buildAmendmentDtos,
  buildDocumentAmendmentContext,
  findAmendmentsAwaitingReview,
} from "./amendments";
import { loadAgendaItems, visibleDocumentsCondition } from "./assemblies";
import { agendaPositions } from "./reviewState";
import {
  buildDocumentSummaries,
  loadMilestones,
  loadMilestonesByAssembly,
} from "./documents";
import {
  SETTLED_PRIVATE_STATUSES,
  amendmentReviewState,
  hasPendingReview,
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
 * and amendments to validate or publish, for amendment:review, grouped by
 * document in agenda order (then creation order) and then in text order.
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
    const pending = await findAmendmentsAwaitingReview(
      visible.map((row) => row.id),
    );
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
        reviewState: amendmentReviewState(row),
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
 * assemblies with something pending are listed.
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
            ),
          )
        : empty,
      reviewAmendments
        ? amendmentCount(
            and(
              isNotNull(amendments.validatedAt),
              isNull(amendments.publishedAt),
              notInArray(amendments.status, [...SETTLED_PRIVATE_STATUSES]),
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
 * GET /api/me/work: across the assemblies that are not closed and that the
 * actor can see, the documents their member presents, the amendments it
 * wrote that are not decided yet and, for the Secretaría, what waits for it.
 */
export async function loadMeWork(actor: Actor): Promise<MeWorkDto> {
  const assemblyRows = await loadWorkAssemblies(actor);
  const now = new Date();
  const [workDocuments, workAmendments, review] = await Promise.all([
    loadWorkDocuments(actor, assemblyRows),
    loadWorkAmendments(actor, assemblyRows),
    loadWorkReview(actor, assemblyRows, now),
  ]);
  return {
    documents: workDocuments,
    amendments: workAmendments,
    review,
  };
}

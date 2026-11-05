import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  agendaItems,
  amendments,
  assemblies,
  documents,
  documentVersions,
  votes,
} from "../../db/schema";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import { consolidate } from "../../../shared/utils/content/consolidate";
import { formatAssemblyLabel } from "../../../shared/utils/slug";
import type { Actor } from "../domain/actor";
import { loadAmendmentVisibility } from "../domain/documents";
import { loadCoProponents, withCoProponentIds } from "../domain/presenters";
import { canSeeAssembly, canSeeDocument } from "../domain/visibility";
import { loadExportActor } from "./actor";
import {
  amendmentCodes,
  buildAgendaTree,
  buildAnnexRows,
  consolidationInput,
  presentersLabel,
  type AgendaTree,
  type AnnexAmendment,
} from "./mapping";
import type {
  AssemblyDocumentEntry,
  AssemblyExportData,
  DocumentExportData,
  ExportAssembly,
  ExportBody,
  ExportDocumentMeta,
  ExportVote,
} from "./pdfBuilder";
import type { AssemblyExportJobData, DocumentExportJobData } from "./queue";
import {
  EXPORT_REFUSAL_MESSAGES,
  ExportRejectedError,
  exportRefusal,
  pickCleanVersion,
} from "./rules";

/**
 * Loads everything a PDF needs, as the requester may see it when the job
 * runs: visibility is checked again with their current role and member.
 * Anything the requester can no longer export fails the job without retry.
 */

type AssemblyRow = typeof assemblies.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;
type VoteRow = typeof votes.$inferSelect;

async function requireExportActor(userId: string): Promise<Actor> {
  const actor = await loadExportActor(userId);
  if (!actor) throw new ExportRejectedError("The requester no longer exists");
  return actor;
}

async function requireExportAssembly(
  actor: Actor,
  assemblyId: string,
): Promise<AssemblyRow> {
  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
  });
  if (!assembly || !canSeeAssembly(actor, assembly)) {
    throw new ExportRejectedError(
      "The assembly is gone or hidden from the requester",
    );
  }
  return assembly;
}

function toExportAssembly(assembly: AssemblyRow): ExportAssembly {
  return {
    label: formatAssemblyLabel(assembly),
    type: assembly.type,
    startDate: assembly.startDate,
    endDate: assembly.endDate,
    location: assembly.location,
  };
}

function toExportVote(vote: VoteRow): ExportVote {
  return {
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
    majority: vote.majority,
    result: vote.result,
    recordedAt: vote.recordedAt,
  };
}

async function loadVotes(
  ids: (string | null)[],
): Promise<Map<string, VoteRow>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(votes).where(inArray(votes.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadVersionBlocks(ids: string[]): Promise<Map<string, Block[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: documentVersions.id, blocks: documentVersions.blocks })
    .from(documentVersions)
    .where(inArray(documentVersions.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row.blocks]));
}

async function loadAgenda(assemblyId: string) {
  return db
    .select({
      id: agendaItems.id,
      parentId: agendaItems.parentId,
      title: agendaItems.title,
      description: agendaItems.description,
      order: agendaItems.order,
    })
    .from(agendaItems)
    .where(eq(agendaItems.assemblyId, assemblyId));
}

function documentMeta(
  document: DocumentRow & { proponent: { acronym: string } | null },
  agenda: AgendaTree,
  agendaTitles: Map<string, string>,
  finalVote: VoteRow | undefined,
  coProponentAcronyms: readonly string[] = [],
): ExportDocumentMeta {
  return {
    title: document.title,
    reference: document.reference,
    kind: document.kind,
    format: document.format,
    proponent: presentersLabel(
      document.proponent?.acronym,
      coProponentAcronyms,
    ),
    fileName: document.fileName,
    agendaNumbering: agenda.numbering.get(document.agendaItemId) ?? null,
    agendaTitle: agendaTitles.get(document.agendaItemId) ?? null,
    finalVote: finalVote ? toExportVote(finalVote) : null,
  };
}

// Document export -------------------------------------------------------------

type LoadedAmendment = AnnexAmendment & { ops: AmendmentOp[] };

async function loadAnnexAmendments(
  documentId: string,
): Promise<LoadedAmendment[]> {
  const rows = await db.query.amendments.findMany({
    where: eq(amendments.documentId, documentId),
    columns: {
      id: true,
      number: true,
      code: true,
      kind: true,
      status: true,
      admission: true,
      late: true,
      approvalMethod: true,
      decidedAt: true,
      positionKey: true,
      outcomeVoteId: true,
      ops: true,
    },
    with: {
      authors: { with: { member: { columns: { id: true, acronym: true } } } },
      sources: { columns: { sourceId: true } },
      derived: { columns: { transactionalId: true } },
    },
    orderBy: [asc(amendments.number), asc(amendments.createdAt)],
  });
  const outcomeVotes = await loadVotes(rows.map((row) => row.outcomeVoteId));
  return rows.map((row) => {
    const vote = row.outcomeVoteId
      ? outcomeVotes.get(row.outcomeVoteId)
      : undefined;
    return {
      id: row.id,
      number: row.number,
      code: row.code,
      kind: row.kind,
      status: row.status,
      admission: row.admission,
      late: row.late,
      approvalMethod: row.approvalMethod,
      decidedAt: row.decidedAt,
      positionKey: row.positionKey,
      authors: row.authors
        .map((author) => author.member.acronym)
        .sort((a, b) => a.localeCompare(b)),
      sourceIds: row.sources.map((source) => source.sourceId),
      derivedIds: row.derived.map((derived) => derived.transactionalId),
      vote: vote
        ? {
            inFavor: vote.inFavor,
            against: vote.against,
            abstentions: vote.abstentions,
          }
        : null,
      ops: row.ops,
    };
  });
}

async function annotatedBody(
  actor: Actor,
  assembly: AssemblyRow,
  document: DocumentRow,
): Promise<ExportBody> {
  const baseVersionId = document.baseVersionId!;
  const [baseBlocks, amendmentRows, { visible }] = await Promise.all([
    loadVersionBlocks([baseVersionId]),
    loadAnnexAmendments(document.id),
    loadAmendmentVisibility(actor, document),
  ]);

  // Only what the requester may read: an amendment that is not published
  // stays out of the text, its codes and the annex. Deciding one needs it
  // published, so for approved amendments this is a second guard.
  const readable = amendmentRows.filter((row) => visible.has(row.id));
  const result = consolidate(
    baseBlocks.get(baseVersionId) ?? [],
    consolidationInput(readable),
  );
  return {
    variant: "annotated",
    blocks: result.annotated,
    codes: amendmentCodes(readable),
    annex: buildAnnexRows({
      amendments: readable,
      visibleIds: visible,
      conflicts: result.conflicts,
    }),
  };
}

async function cleanBody(
  actor: Actor,
  document: DocumentRow,
): Promise<ExportBody> {
  const picked = pickCleanVersion(actor, document);
  if (!picked) throw new ExportRejectedError(EXPORT_REFUSAL_MESSAGES.no_text);
  const blocks = await loadVersionBlocks([picked.versionId]);
  return {
    variant: "clean",
    source: picked.source,
    blocks: blocks.get(picked.versionId) ?? [],
  };
}

export async function buildDocumentExportData(
  job: DocumentExportJobData,
): Promise<DocumentExportData> {
  const actor = await requireExportActor(job.requestedBy);
  const assembly = await requireExportAssembly(actor, job.assemblyId);
  const row = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, job.documentId),
      eq(documents.assemblyId, assembly.id),
    ),
    with: { proponent: { columns: { acronym: true } } },
  });
  // Co-presenters see a draft like its main presenter.
  const document = row ? (await withCoProponentIds([row]))[0] : undefined;
  if (!document || !canSeeDocument(actor, document)) {
    throw new ExportRejectedError(
      "The document is gone or hidden from the requester",
    );
  }
  const refusal = exportRefusal(actor, document, job.variant);
  if (refusal) throw new ExportRejectedError(EXPORT_REFUSAL_MESSAGES[refusal]);

  const [agendaRows, finalVotes, coProponents, body] = await Promise.all([
    loadAgenda(assembly.id),
    loadVotes([document.finalVoteId]),
    loadCoProponents([document.id]),
    job.variant === "annotated"
      ? annotatedBody(actor, assembly, document)
      : cleanBody(actor, document),
  ]);
  const agenda = buildAgendaTree(agendaRows);
  const agendaTitles = new Map(agendaRows.map((row) => [row.id, row.title]));

  return {
    assembly: toExportAssembly(assembly),
    document: documentMeta(
      document,
      agenda,
      agendaTitles,
      document.finalVoteId ? finalVotes.get(document.finalVoteId) : undefined,
      (coProponents.get(document.id) ?? []).map((member) => member.acronym),
    ),
    body,
    generatedAt: new Date(),
  };
}

// Assembly export -------------------------------------------------------------

/**
 * Cover, agenda and every published document in agenda order. Only
 * published documents are listed, so the dossier never reveals drafts or
 * submissions under review, whoever requests it.
 */
export async function buildAssemblyExportData(
  job: AssemblyExportJobData,
): Promise<AssemblyExportData> {
  const actor = await requireExportActor(job.requestedBy);
  const assembly = await requireExportAssembly(actor, job.assemblyId);

  const [agendaRows, documentRows] = await Promise.all([
    loadAgenda(assembly.id),
    db.query.documents.findMany({
      where: and(
        eq(documents.assemblyId, assembly.id),
        eq(documents.status, "published"),
      ),
      with: { proponent: { columns: { acronym: true } } },
      orderBy: [asc(documents.createdAt), asc(documents.id)],
    }),
  ]);

  const agenda = buildAgendaTree(agendaRows, documentRows);
  const agendaTitles = new Map(agendaRows.map((row) => [row.id, row.title]));
  const versionOf = (document: DocumentRow) =>
    document.format === "structured"
      ? (document.consolidatedVersionId ?? document.baseVersionId)
      : null;

  const [finalVotes, versions, coProponents] = await Promise.all([
    loadVotes(documentRows.map((document) => document.finalVoteId)),
    loadVersionBlocks(
      documentRows.map(versionOf).filter((id): id is string => Boolean(id)),
    ),
    loadCoProponents(documentRows.map((document) => document.id)),
  ]);

  const byId = new Map(documentRows.map((document) => [document.id, document]));
  const entries: AssemblyDocumentEntry[] = agenda.documentOrder.map((id) => {
    const document = byId.get(id)!;
    const versionId = versionOf(document);
    return {
      meta: documentMeta(
        document,
        agenda,
        agendaTitles,
        document.finalVoteId ? finalVotes.get(document.finalVoteId) : undefined,
        (coProponents.get(document.id) ?? []).map((member) => member.acronym),
      ),
      source:
        document.format === "file"
          ? null
          : document.consolidatedVersionId
            ? "consolidated"
            : "base",
      blocks: versionId ? (versions.get(versionId) ?? []) : [],
    };
  });

  return {
    assembly: toExportAssembly(assembly),
    agenda: agenda.nodes,
    documents: entries,
    generatedAt: new Date(),
  };
}

import { and, asc, eq, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../db";
import {
  agendaItems,
  amendments,
  assemblies,
  documents,
  documentImages,
  documentVersions,
  votes,
} from "../../db/schema";
import type { MemberKind } from "../../../shared/constants/domain";
import type { AmendmentOp, Block } from "../../../shared/types/content";
import {
  hiddenTitleItemIds,
  titleDocumentId,
  visibleAgendaItems,
} from "../../../shared/utils/agendaSubmissions";
import { consolidate } from "../../../shared/utils/content/consolidate";
import { formatAssemblyLabel } from "../../../shared/utils/slug";
import { canManageDocuments, type Actor } from "../domain/actor";
import { loadAmendmentVisibility } from "../domain/documents";
import { getImageDir, imageFileName } from "../domain/documentImages";
import { logError } from "../core/logger";
import { loadCoProponents, withCoProponentIds } from "../domain/presenters";
import {
  canSeeAssembly,
  canSeeDocument,
  visibleAcronym,
} from "../domain/visibility";
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
import type { ExportImage } from "./content";
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
      generatedForDocumentId: agendaItems.generatedForDocumentId,
      hiddenWithDocumentId: agendaItems.hiddenWithDocumentId,
      titleWithheld: agendaItems.titleWithheld,
    })
    .from(agendaItems)
    .where(eq(agendaItems.assemblyId, assemblyId));
}

type AcronymMember = { acronym: string; kind: MemberKind };

/**
 * The co-presenters' acronyms as the actor reads them. They come in acronym
 * order; when an area reads as "CEA" they are sorted again, since where the
 * area sat would narrow down which one it is.
 */
function visibleCoAcronyms(
  actor: Actor,
  coProponents: readonly AcronymMember[],
): string[] {
  const acronyms = coProponents.map((member) => visibleAcronym(actor, member));
  const hidden = coProponents.some(
    (member, index) => member.acronym !== acronyms[index],
  );
  return hidden
    ? [...new Set(acronyms)].sort((a, b) => a.localeCompare(b))
    : acronyms;
}

/**
 * `actor` is the requester: an executive area is printed as "CEA" for one
 * who may not see the areas (presentersLabel then names it once).
 */
function documentMeta(
  actor: Actor,
  document: DocumentRow & { proponent: AcronymMember | null },
  agenda: AgendaTree,
  agendaTitles: Map<string, string>,
  finalVote: VoteRow | undefined,
  coProponents: readonly AcronymMember[] = [],
): ExportDocumentMeta {
  return {
    title: document.title,
    reference: document.reference,
    kind: document.kind,
    format: document.format,
    proponent: presentersLabel(
      document.proponent ? visibleAcronym(actor, document.proponent) : null,
      visibleCoAcronyms(actor, coProponents),
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
  actor: Actor,
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
      authors: {
        with: { member: { columns: { id: true, acronym: true, kind: true } } },
      },
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
      // Several areas read as one "CEA" for a requester who may not see them.
      authors: [
        ...new Set(
          row.authors.map((author) => visibleAcronym(actor, author.member)),
        ),
      ].sort((a, b) => a.localeCompare(b)),
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
    loadAnnexAmendments(actor, document.id),
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

/**
 * The images the exported text shows, read from disk as data URLs. Only
 * images of the documents being exported: content never points elsewhere
 * (assertImagesBelong), and this keeps it so. One missing on disk is left
 * out (the PDF shows its description instead) and logged.
 */
async function loadExportImages(
  documentIds: string[],
  blocks: { type: string; image?: { asset: string } }[],
): Promise<Record<string, ExportImage>> {
  const assets = new Set<string>();
  for (const block of blocks) {
    if (block.type === "image" && block.image) assets.add(block.image.asset);
  }
  if (assets.size === 0 || documentIds.length === 0) return {};
  const rows = await db
    .select({
      id: documentImages.id,
      mimeType: documentImages.mimeType,
      width: documentImages.width,
      height: documentImages.height,
    })
    .from(documentImages)
    .where(
      and(
        inArray(documentImages.id, [...assets]),
        inArray(documentImages.documentId, documentIds),
      ),
    );
  const images: Record<string, ExportImage> = {};
  for (const row of rows) {
    const name = imageFileName(row.id, row.mimeType);
    if (!name) continue;
    try {
      const data = await readFile(join(getImageDir(), name));
      images[row.id] = {
        dataUrl: `data:${row.mimeType};base64,${data.toString("base64")}`,
        width: row.width,
        height: row.height,
      };
    } catch (error) {
      logError("export.loadExportImages", error);
    }
  }
  return images;
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
    with: { proponent: { columns: { acronym: true, kind: true } } },
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
  // The item it hangs from may carry the title of another document (it was
  // that one's automatic sub-item): never print it for a requester who
  // cannot see that document.
  const item = agendaRows.find((row) => row.id === document.agendaItemId);
  const titleOf = item ? titleDocumentId(item) : null;
  if (item && titleOf && titleOf !== document.id) {
    const other = await db.query.documents.findFirst({
      where: eq(documents.id, titleOf),
    });
    const [source] = other ? await withCoProponentIds([other]) : [];
    if (source && !canSeeDocument(actor, source)) agendaTitles.delete(item.id);
  }
  // Nor a title withheld since its document was deleted.
  if (item?.titleWithheld && !canManageDocuments(actor)) {
    agendaTitles.delete(item.id);
  }
  const images = await loadExportImages([document.id], body.blocks);

  return {
    images,
    assembly: toExportAssembly(assembly),
    document: documentMeta(
      actor,
      document,
      agenda,
      agendaTitles,
      document.finalVoteId ? finalVotes.get(document.finalVoteId) : undefined,
      coProponents.get(document.id) ?? [],
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

  const [allAgendaRows, documentRows, postponedRows] = await Promise.all([
    loadAgenda(assembly.id),
    db.query.documents.findMany({
      where: and(
        eq(documents.assemblyId, assembly.id),
        eq(documents.status, "published"),
      ),
      with: { proponent: { columns: { acronym: true, kind: true } } },
      orderBy: [asc(documents.createdAt), asc(documents.id)],
    }),
    db
      .select({ id: documents.id, agendaItemId: documents.agendaItemId })
      .from(documents)
      .where(
        and(
          eq(documents.assemblyId, assembly.id),
          eq(documents.status, "postponed"),
        ),
      ),
  ]);
  // A postponed document is not printed, but everyone reads it in the
  // platform (canSeeDocument), so the items that carry its title keep it.
  const publicDocuments = [...documentRows, ...postponedRows];
  // An item that carries the title of a document that is not public (its
  // automatic sub-item, or one kept after it moved away or was deleted) is
  // left out, or printed without that title when it holds something
  // published. The same for every requester, managers included.
  const keptRows = visibleAgendaItems(allAgendaRows, publicDocuments);
  const hiddenTitles = hiddenTitleItemIds(keptRows, publicDocuments);
  const agendaRows = keptRows.map((row) =>
    hiddenTitles.has(row.id)
      ? { ...row, title: "", description: null, titleHidden: true }
      : row,
  );

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
        actor,
        document,
        agenda,
        agendaTitles,
        document.finalVoteId ? finalVotes.get(document.finalVoteId) : undefined,
        coProponents.get(document.id) ?? [],
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

  const images = await loadExportImages(
    documentRows.map((document) => document.id),
    entries.flatMap((entry) => entry.blocks),
  );

  return {
    assembly: toExportAssembly(assembly),
    agenda: agenda.nodes,
    documents: entries,
    generatedAt: new Date(),
    images,
  };
}

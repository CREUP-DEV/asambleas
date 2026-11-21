import { and, asc, eq, inArray } from "drizzle-orm";
import { alternativeLetter } from "../../../shared/utils/alternativesVote";
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
import { unlistedAgendaItemIds } from "../../../shared/utils/agendaNumbering";
import {
  hiddenTitleItemIds,
  PUBLIC_DOCUMENT_STATUSES,
  titleDocumentId,
  visibleAgendaItems,
} from "../../../shared/utils/agendaSubmissions";
import { consolidateApproved } from "../../../shared/utils/content/passages";
import { positionsArePublic } from "../../../shared/utils/positions";
import { formatAssemblyLabel } from "../../../shared/utils/slug";
import {
  canManageAssemblies,
  canManageDocuments,
  type Actor,
} from "../domain/actor";
import { loadAmendmentVisibility } from "../domain/documents";
import { loadPassageWordings, wordingInputs } from "../domain/wordings";
import { getImageDir, imageFileName } from "../domain/documentImages";
import { logError } from "../core/logger";
import { loadCoProponents, withCoProponentIds } from "../domain/presenters";
import type { VoteRow } from "../domain/votes";
import {
  canSeeAssembly,
  canSeeDocument,
  visibleAcronym,
} from "../domain/visibility";
import { loadExportActor, publicExportActor } from "./actor";
import {
  amendmentCode,
  amendmentCodes,
  buildAgendaTree,
  buildAnnexRows,
  consolidationInput,
  presentersLabel,
  type AgendaTree,
  type AnnexAmendment,
} from "./mapping";
import { storedPendingPassages } from "../../../shared/utils/content/pendingPassages";
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

export function toExportAssembly(assembly: AssemblyRow): ExportAssembly {
  return {
    label: formatAssemblyLabel(assembly),
    number: assembly.number,
    type: assembly.type,
    startDate: assembly.startDate,
    endDate: assembly.endDate,
    location: assembly.location,
  };
}

/** Its option in a vote between alternatives, and that option's votes. */
function alternativeOf(
  vote: VoteRow,
  amendmentId: string,
): { alternative?: { option: string; count: number } } {
  const index =
    vote.options?.findIndex((option) =>
      option.amendmentIds.includes(amendmentId),
    ) ?? -1;
  if (index < 0) return {};
  return {
    alternative: {
      option: alternativeLetter(index),
      count: vote.options![index]!.count,
    },
  };
}

export function toExportVote(vote: VoteRow): ExportVote {
  return {
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
    blank: vote.blank,
    majority: vote.majority,
    result: vote.result,
    method: vote.method,
    // An assent the approval line words «unanimidad».
    unanimous: vote.unanimous,
    recordedAt: vote.recordedAt,
  };
}

export async function loadVotes(
  ids: (string | null)[],
): Promise<Map<string, VoteRow>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(votes).where(inArray(votes.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function loadVersionBlocks(
  ids: string[],
): Promise<Map<string, Block[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: documentVersions.id, blocks: documentVersions.blocks })
    .from(documentVersions)
    .where(inArray(documentVersions.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row.blocks]));
}

/**
 * The passages each consolidated version leaves pending conciliation
 * (user's decisions of 2026-11-21), as the files name them: the codes of
 * the approved amendments that collide there and its first block in the
 * text. Versions whose text is final are left out.
 */
export async function loadPendingConciliation(
  versionIds: (string | null | undefined)[],
): Promise<
  Map<string, NonNullable<ExportDocumentMeta["pendingConciliation"]>>
> {
  const ids = [...new Set(versionIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: documentVersions.id,
      pending: documentVersions.pendingPassages,
    })
    .from(documentVersions)
    .where(inArray(documentVersions.id, ids));
  const pending = rows
    .map((row) => [row.id, storedPendingPassages(row.pending)] as const)
    .filter(([, passages]) => passages.length > 0);
  const amendmentIds = [
    ...new Set(
      pending.flatMap(([, passages]) =>
        passages.flatMap((passage) => passage.amendmentIds),
      ),
    ),
  ];
  const codes =
    amendmentIds.length > 0
      ? await db
          .select({
            id: amendments.id,
            code: amendments.code,
            number: amendments.number,
          })
          .from(amendments)
          .where(inArray(amendments.id, amendmentIds))
      : [];
  const codeOf = new Map(codes.map((row) => [row.id, amendmentCode(row)]));
  return new Map(
    pending.map(([id, passages]) => [
      id,
      passages.map((passage) => ({
        blockId: passage.textBlockIds[0] ?? null,
        codes: passage.amendmentIds.map(
          (amendmentId) => codeOf.get(amendmentId) ?? "?",
        ),
      })),
    ]),
  );
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

/** The documents everyone reads, with the item each hangs from. */
function loadPublicDocuments(assemblyId: string) {
  return db
    .select({ id: documents.id, agendaItemId: documents.agendaItemId })
    .from(documents)
    .where(
      and(
        eq(documents.assemblyId, assemblyId),
        inArray(documents.status, PUBLIC_DOCUMENT_STATUSES),
      ),
    );
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
 * `actor` is who the header is written for: an executive office is printed
 * as "CEA" for one who may not see the offices (presentersLabel then names
 * it once). Always the requester, for every PDF: the Secretaría's and the
 * Mesa's read the real offices, a delegate's the generic "CEA".
 */
export function documentMeta(
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

/** `actor` is the requester: it decides how the authors' offices read. */
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
      position: { columns: { position: true } },
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
      answer: row.position?.position ?? null,
      // Several offices read as one "CEA" for a reader who may not see them.
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
            blank: vote.blank,
            method: vote.method,
            ...alternativeOf(vote, row.id),
          }
        : null,
      ops: row.ops,
    };
  });
}

/**
 * The annotated text: its marks and annex. Like the clean PDF, it names the
 * authors as the requester reads them (the Secretaría and the Mesa read the
 * real offices, a delegate the generic "CEA"). Which amendments it carries
 * is the same for everyone: only the published ones (publicExportActor
 * decides it), so an amendment presented but never published (withdrawn
 * before, declared inadmissible, still awaiting validation) never reaches a
 * file that is filed with the minutes.
 */
export async function annotatedBody(
  actor: Actor,
  document: Pick<DocumentRow, "id" | "baseVersionId"> &
    Partial<
      Pick<
        DocumentRow,
        | "positionsPublishedAt"
        | "positionsDebateStartedAt"
        | "finalVoteId"
        | "consolidatedVersionId"
      >
    >,
): Promise<ExportBody> {
  const baseVersionId = document.baseVersionId!;
  const [baseBlocks, amendmentRows, { visible }] = await Promise.all([
    loadVersionBlocks([baseVersionId]),
    loadAnnexAmendments(actor, document.id),
    loadAmendmentVisibility(publicExportActor(), document),
  ]);

  // Only what everyone may read: an amendment that is not published stays
  // out of the text, its codes and the annex. Deciding one needs it
  // published, so for approved amendments this is a second guard.
  const readable = amendmentRows.filter((row) => visible.has(row.id));
  // The text as the final vote fixes it: the Mesa's wordings over the
  // readable amendments apply (shared/utils/content/passages.ts).
  const wordings = (await loadPassageWordings(db, document.id)).filter((row) =>
    row.amendmentIds.every((id) => visible.has(id)),
  );
  const result = consolidateApproved(
    baseBlocks.get(baseVersionId) ?? [],
    consolidationInput(readable),
    { wordings: wordingInputs(wordings) },
  );
  // The passages the final vote left pending conciliation stay pending in
  // the annex until they are conciliated (user's decisions of 2026-11-21).
  const stillPending = new Set<string>();
  if (document.consolidatedVersionId) {
    const [version] = await db
      .select({ pending: documentVersions.pendingPassages })
      .from(documentVersions)
      .where(eq(documentVersions.id, document.consolidatedVersionId));
    for (const passage of storedPendingPassages(version?.pending)) {
      stillPending.add(passage.key);
    }
  }
  return {
    variant: "annotated",
    blocks: result.annotated,
    codes: amendmentCodes(readable),
    wordingIds: result.wordingIds,
    annex: buildAnnexRows({
      amendments: readable,
      visibleIds: visible,
      conflicts: result.conflicts,
      // Once the text is voted only what it left pending conciliation is
      // pending: a passage voted before the Mesa worded passages (both
      // touching changes applied) stays so.
      passages:
        document.finalVoteId || document.consolidatedVersionId
          ? result.passages.filter(
              (passage) =>
                passage.status === "worded" ||
                (passage.status === "pending" && stillPending.has(passage.key)),
            )
          : result.passages,
      superseded: result.superseded,
      // The order the room debated them in (inDebateOrder).
      byAnswer: positionsArePublic({
        positionsPublishedAt: document.positionsPublishedAt ?? null,
        positionsDebateStartedAt: document.positionsDebateStartedAt ?? null,
      }),
    }),
  };
}

/**
 * The images the exported text shows, read from disk as data URLs. Only
 * images of the documents being exported: content never points elsewhere
 * (assertImagesBelong), and this keeps it so. One missing on disk is left
 * out (the PDF shows its description instead) and logged.
 */
export async function loadExportImages(
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
  // Every PDF is written for its requester, the annotated one too.
  const reader = actor;

  const [agendaRows, publicDocuments, finalVotes, coProponents, body] =
    await Promise.all([
      loadAgenda(assembly.id),
      loadPublicDocuments(assembly.id),
      loadVotes([document.finalVoteId]),
      loadCoProponents([document.id]),
      job.variant === "annotated"
        ? annotatedBody(actor, document)
        : cleanBody(actor, document),
    ]);
  // The number everyone reads for its item: none while the item is not in
  // the agenda for everyone (the document is not public yet).
  const unlisted = unlistedAgendaItemIds(agendaRows, publicDocuments);
  const agenda = buildAgendaTree(
    agendaRows.map((row) =>
      unlisted.has(row.id) ? { ...row, unlisted: true } : row,
    ),
  );
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
    if (source && !canSeeDocument(reader, source)) {
      agendaTitles.delete(item.id);
    }
  }
  // Nor a title withheld since its document was deleted.
  if (item?.titleWithheld && !canManageDocuments(reader)) {
    agendaTitles.delete(item.id);
  }
  const [images, pendingConciliation] = await Promise.all([
    loadExportImages([document.id], body.blocks),
    loadPendingConciliation([document.consolidatedVersionId]),
  ]);

  return {
    images,
    assembly: toExportAssembly(assembly),
    document: {
      ...documentMeta(
        reader,
        document,
        agenda,
        agendaTitles,
        document.finalVoteId ? finalVotes.get(document.finalVoteId) : undefined,
        coProponents.get(document.id) ?? [],
      ),
      pendingConciliation: document.consolidatedVersionId
        ? (pendingConciliation.get(document.consolidatedVersionId) ?? [])
        : [],
    },
    body,
    generatedAt: new Date(),
  };
}

// Assembly export -------------------------------------------------------------

/**
 * The agenda as everyone reads it, with the documents it publishes: the
 * published ones (`documents`, agenda order in `agenda.documentOrder`) and
 * the postponed ones (`postponed`), which everyone reads in the platform but
 * no export prints. An item that carries the title of a document that is
 * not public (its automatic sub-item, or one kept after it moved away or
 * was deleted) is left out, or kept without that title (`titleHidden`) when
 * it holds something published. The same for every requester, managers
 * included: the dossier and the documentation package go round.
 */
export async function loadPublishedAgenda(assemblyId: string) {
  const [allAgendaRows, documentRows, postponedRows] = await Promise.all([
    loadAgenda(assemblyId),
    db.query.documents.findMany({
      where: and(
        eq(documents.assemblyId, assemblyId),
        eq(documents.status, "published"),
      ),
      with: { proponent: { columns: { acronym: true, kind: true } } },
      orderBy: [asc(documents.createdAt), asc(documents.id)],
    }),
    db.query.documents.findMany({
      where: and(
        eq(documents.assemblyId, assemblyId),
        eq(documents.status, "postponed"),
      ),
      columns: {
        id: true,
        agendaItemId: true,
        title: true,
        reference: true,
      },
      orderBy: [asc(documents.createdAt), asc(documents.id)],
    }),
  ]);
  // The items that carry a postponed document's title keep it.
  const publicDocuments = [...documentRows, ...postponedRows];
  const keptRows = visibleAgendaItems(allAgendaRows, publicDocuments);
  const hiddenTitles = hiddenTitleItemIds(keptRows, publicDocuments);
  const agendaRows = keptRows.map((row) =>
    hiddenTitles.has(row.id)
      ? { ...row, title: "", description: null, titleHidden: true }
      : row,
  );
  return {
    agendaRows,
    documentRows,
    postponed: postponedRows,
    agenda: buildAgendaTree(agendaRows, documentRows),
  };
}

/**
 * Cover, agenda and every published document in agenda order. Only
 * published documents are listed, so the dossier never reveals drafts or
 * submissions under review, whoever requests it. Only managers request it,
 * and they see the executive offices, but the file goes round: its
 * presenters are printed as anyone reads them, the offices as "CEA".
 */
export async function buildAssemblyExportData(
  job: AssemblyExportJobData,
): Promise<AssemblyExportData> {
  const actor = await requireExportActor(job.requestedBy);
  // Checked again: the job may outlive the requester's role.
  if (!canManageAssemblies(actor)) {
    throw new ExportRejectedError("The requester no longer manages assemblies");
  }
  const assembly = await requireExportAssembly(actor, job.assemblyId);

  const { agendaRows, documentRows, agenda } = await loadPublishedAgenda(
    assembly.id,
  );
  const agendaTitles = new Map(agendaRows.map((row) => [row.id, row.title]));
  const versionOf = (document: DocumentRow) =>
    document.format === "structured"
      ? (document.consolidatedVersionId ?? document.baseVersionId)
      : null;

  const [finalVotes, versions, coProponents, pendingConciliation] =
    await Promise.all([
      loadVotes(documentRows.map((document) => document.finalVoteId)),
      loadVersionBlocks(
        documentRows.map(versionOf).filter((id): id is string => Boolean(id)),
      ),
      loadCoProponents(documentRows.map((document) => document.id)),
      loadPendingConciliation(
        documentRows.map((document) =>
          document.format === "structured"
            ? document.consolidatedVersionId
            : null,
        ),
      ),
    ]);

  // Written for the requester, like every PDF (managers only: real offices).
  const reader = actor;
  const byId = new Map(documentRows.map((document) => [document.id, document]));
  const entries: AssemblyDocumentEntry[] = agenda.documentOrder.map((id) => {
    const document = byId.get(id)!;
    const versionId = versionOf(document);
    return {
      meta: {
        ...documentMeta(
          reader,
          document,
          agenda,
          agendaTitles,
          document.finalVoteId
            ? finalVotes.get(document.finalVoteId)
            : undefined,
          coProponents.get(document.id) ?? [],
        ),
        pendingConciliation: document.consolidatedVersionId
          ? (pendingConciliation.get(document.consolidatedVersionId) ?? [])
          : [],
      },
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

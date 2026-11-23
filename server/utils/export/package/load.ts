import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import { amendments, assemblies, assemblyMilestones } from "../../../db/schema";
import { agendaFinalSince } from "../../../../shared/utils/calendar";
import { formatAssemblyLabel } from "../../../../shared/utils/slug";
import { agendaChildGroups } from "../../../../shared/utils/agendaNumbering";
import { loadVisibleAmendmentIds, storedPdfName } from "../../domain/documents";
import { convocationStoredName } from "../../domain/convocation";
import {
  loadSignedRecordFile,
  signedRecordStoredName,
} from "../../domain/agreementsSignedFile";
import type { StoredAmendmentMeta } from "../../domain/amendments";
import type { MemberKind } from "../../../../shared/constants/domain";
import { loadCoProponents } from "../../domain/presenters";
import {
  canSeeAssembly,
  redactMember,
  visibleAcronym,
} from "../../domain/visibility";
import { publicExportActor } from "../actor";
import {
  documentMeta,
  loadPendingConciliation,
  loadPublishedAgenda,
  loadVotes,
} from "../buildData";
import { amendmentCode } from "../mapping";
import type {
  PackageAmendment,
  PackageAuthor,
  PackageDocument,
  PackageItem,
  PackageSource,
} from "./plan";

/**
 * Reads what the documentation package shows, as a reader who sees only
 * what is public reads it (publicExportActor): one package for everyone, so
 * nothing in it may depend on who asks. Published documents only, as the
 * dossier (a postponed one is listed in the convocatoria, not printed), their
 * published amendments, the executive offices as the generic "CEA".
 * Answers null for an assembly the public does not see (a draft).
 */
export async function loadPackageSource(
  assemblyId: string,
  now: Date = new Date(),
): Promise<PackageSource | null> {
  const reader = publicExportActor();
  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
  });
  if (!assembly || !canSeeAssembly(reader, assembly)) return null;

  const [milestones, published] = await Promise.all([
    db
      .select({
        key: assemblyMilestones.key,
        at: assemblyMilestones.at,
        note: assemblyMilestones.note,
      })
      .from(assemblyMilestones)
      .where(eq(assemblyMilestones.assemblyId, assembly.id)),
    loadPublishedAgenda(assembly.id),
  ]);
  const { agendaRows, documentRows, postponed, agenda } = published;

  // Numbered items, depth first, with the public documents under each.
  const listed = new Map<string, PackageItem["documents"]>();
  for (const document of [...documentRows, ...postponed]) {
    const list = listed.get(document.agendaItemId) ?? [];
    list.push({ title: document.title, reference: document.reference });
    listed.set(document.agendaItemId, list);
  }
  const children = agendaChildGroups(agendaRows);
  const items: PackageItem[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const row of children.get(parentId) ?? []) {
      const numbering = agenda.numbering.get(row.id) ?? null;
      if (numbering === null) continue;
      items.push({
        id: row.id,
        // The parent it is numbered under (a missing parent makes a root).
        parentId,
        numbering,
        title: "titleHidden" in row && row.titleHidden ? null : row.title,
        depth,
        automaticFor: row.generatedForDocumentId ?? null,
        documents: listed.get(row.id) ?? [],
      });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);

  const structuredIds = documentRows
    .filter((document) => document.format === "structured")
    .map((document) => document.id);
  const [finalVotes, coProponents, visibleAmendments, pendingConciliation] =
    await Promise.all([
      loadVotes(documentRows.map((document) => document.finalVoteId)),
      loadCoProponents(documentRows.map((document) => document.id)),
      loadVisibleAmendmentIds(reader, structuredIds),
      loadPendingConciliation(
        documentRows.map((document) =>
          document.format === "structured"
            ? document.consolidatedVersionId
            : null,
        ),
      ),
    ]);
  const { byDocument: amendmentsByDocument, authors } =
    await loadPackageAmendments([...visibleAmendments]);
  // The acta de acuerdos once signed: its signed PDF stands for its own.
  const signedRecords = new Map<string, string>();
  for (const document of documentRows) {
    if (document.generated !== "agreements_record") continue;
    const signed = await loadSignedRecordFile(document);
    if (signed) signedRecords.set(document.id, signed.url);
  }

  const byId = new Map(documentRows.map((document) => [document.id, document]));
  const documents: PackageDocument[] = agenda.documentOrder.map((id) => {
    const document = byId.get(id)!;
    const meta = documentMeta(
      reader,
      document,
      agenda,
      new Map(),
      document.finalVoteId ? finalVotes.get(document.finalVoteId) : undefined,
      coProponents.get(document.id) ?? [],
    );
    return {
      id: document.id,
      agendaItemId: document.agendaItemId,
      title: document.title,
      reference: document.reference,
      kind: document.kind,
      format: document.format,
      proponent: meta.proponent,
      finalVote: meta.finalVote,
      pendingConciliation: document.consolidatedVersionId
        ? (pendingConciliation.get(document.consolidatedVersionId) ?? [])
        : [],
      baseVersionId: document.baseVersionId,
      consolidatedVersionId: document.consolidatedVersionId,
      fileUrl: document.format === "file" ? document.fileUrl : null,
      storedFile:
        document.format === "file" ? storedPdfName(document.fileUrl) : null,
      signedFileUrl: signedRecords.get(document.id) ?? null,
      signedStoredFile: signedRecordStoredName(signedRecords.get(document.id)),
      amendments:
        document.format === "structured"
          ? (amendmentsByDocument.get(document.id) ?? [])
          : [],
    };
  });

  const convocationStoredFile = convocationStoredName(
    assembly.convocationFileUrl,
  );
  return {
    assembly: {
      id: assembly.id,
      label: formatAssemblyLabel(assembly),
      number: assembly.number,
      type: assembly.type,
      startDate: assembly.startDate,
      endDate: assembly.endDate,
      location: assembly.location,
      agendaFinal: agendaFinalSince(milestones, now) !== null,
      convocationIntro: assembly.convocationIntro,
      convocationFileUrl: convocationStoredFile
        ? assembly.convocationFileUrl
        : null,
      convocationStoredFile,
      milestones,
    },
    items,
    documents,
    authors,
  };
}

/** The published amendments by document, by number, as the public names them. */
async function loadPackageAmendments(ids: string[]): Promise<{
  byDocument: Map<string, PackageAmendment[]>;
  authors: PackageAuthor[];
}> {
  const byDocument = new Map<string, PackageAmendment[]>();
  const authors = new Map<string, PackageAuthor>();
  if (ids.length === 0) return { byDocument, authors: [] };
  const reader = publicExportActor();
  const rows = await db.query.amendments.findMany({
    where: inArray(amendments.id, ids),
    columns: {
      id: true,
      documentId: true,
      number: true,
      code: true,
      kind: true,
      status: true,
      approvalMethod: true,
      updatedAt: true,
      meta: true,
    },
    with: {
      authors: {
        with: {
          member: {
            columns: {
              id: true,
              acronym: true,
              name: true,
              kind: true,
              university: true,
            },
          },
        },
      },
      sources: { columns: { sourceId: true } },
      derived: { columns: { transactionalId: true } },
    },
    orderBy: [asc(amendments.number), asc(amendments.createdAt)],
  });
  const visible = new Set(ids);
  const codes = new Map(rows.map((row) => [row.id, amendmentCode(row)]));
  const codeOf = (id: string) => (visible.has(id) ? codes.get(id) : undefined);
  const status = new Map(rows.map((row) => [row.id, row.status]));
  /** A member as the public reads it: an office as the generic "CEA". */
  const publicAuthor = (member: {
    id: string;
    acronym: string;
    name: string;
    kind: MemberKind;
    university: string | null;
  }): PackageAuthor => {
    const shown = redactMember(reader, member);
    return {
      id: shown.id,
      acronym: visibleAcronym(reader, shown),
      name: shown.name,
      kind: shown.kind,
      university: shown.id === member.id ? member.university : null,
    };
  };

  for (const row of rows) {
    const main = (row.meta as StoredAmendmentMeta).presentingMemberId;
    // Sorted by the acronym as read: where an office sat among the real
    // acronyms would narrow down which one reads as "CEA".
    const mainAuthor = row.authors.find((author) => author.member.id === main);
    const others = row.authors
      .filter((author) => author !== mainAuthor)
      .map((author) => publicAuthor(author.member))
      .sort((a, b) => a.acronym.localeCompare(b.acronym));
    // Several offices read as one "CEA".
    const signers = new Map(
      [...(mainAuthor ? [publicAuthor(mainAuthor.member)] : []), ...others].map(
        (author) => [author.id, author],
      ),
    );
    for (const author of signers.values()) {
      if (!authors.has(author.id)) authors.set(author.id, author);
    }
    const derived = row.derived
      .map((link) => link.transactionalId)
      .filter((id) => visible.has(id));
    const approved = derived.filter((id) => status.get(id) === "approved");
    const list = byDocument.get(row.documentId) ?? [];
    list.push({
      id: row.id,
      number: row.number,
      code: row.code,
      kind: row.kind,
      status: row.status,
      approvalMethod: row.approvalMethod,
      updatedAt: row.updatedAt,
      authors: [...signers.values()].map((author) => author.acronym),
      authorIds: [...signers.keys()],
      sourceCodes: row.sources
        .map((link) => codeOf(link.sourceId))
        .filter((code): code is string => Boolean(code)),
      transactedInto: (approved.length > 0 ? approved : derived)
        .map(codeOf)
        .filter((code): code is string => Boolean(code)),
    });
    byDocument.set(row.documentId, list);
  }
  return { byDocument, authors: [...authors.values()] };
}

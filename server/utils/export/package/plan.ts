import { createHash } from "node:crypto";
import type { AssemblyType } from "../../../../shared/constants/assemblyTypes";
import type {
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  DocumentFormat,
  DocumentKind,
} from "../../../../shared/constants/domain";
import type { ExportLocale, Translate } from "../labels";
import type { ExportVote } from "../pdfBuilder";
import { NameRegistry, safeName, sortableNumbering } from "./names";

/**
 * What goes into the documentation package of an assembly, and under which
 * path: pure, from what a reader who sees only what is public reads
 * (load.ts). Each file is a piece with a key that changes whenever anything
 * it shows changes; pieces are rendered once and kept (build.ts), so a
 * package rebuilt after one amendment changes renders that amendment alone.
 * The plan's fingerprint changes whenever any path or key does: the ZIP of
 * a fingerprint never needs building twice.
 */

/**
 * Bumped whenever a piece would come out different from the same data (a
 * template or layout change): every piece is rendered again.
 */
export const PACKAGE_RENDERER_VERSION = 1;

/** Longest folder name taken from an agenda item's title. */
const FOLDER_TITLE_MAX = 50;
/** Longest file name taken from a document's reference and title. */
const FILE_TITLE_MAX = 60;

export interface PackageAmendment {
  id: string;
  number: number | null;
  code: string | null;
  kind: AmendmentKind;
  status: AmendmentStatus;
  approvalMethod: ApprovalMethod | null;
  /** Any change to the amendment (text, explanation, outcome) moves it. */
  updatedAt: Date;
  /** Acronyms as the public reads them, the main author first. */
  authors: string[];
  sourceCodes: string[];
  transactedInto: string[];
}

export interface PackageDocument {
  id: string;
  agendaItemId: string;
  title: string;
  reference: string | null;
  kind: DocumentKind;
  format: DocumentFormat;
  /** Who presents it, as the public reads it. */
  proponent: string | null;
  finalVote: ExportVote | null;
  baseVersionId: string | null;
  consolidatedVersionId: string | null;
  /** The uploaded PDF's URL and its name on disk. */
  fileUrl: string | null;
  storedFile: string | null;
  /** Published amendments, by number. */
  amendments: PackageAmendment[];
}

export interface PackageItem {
  id: string;
  parentId: string | null;
  numbering: string;
  /** Null when the item carries the title of a document that is not public. */
  title: string | null;
  depth: number;
  /** Public documents under it (published and postponed), for the convocatoria. */
  documents: { title: string; reference: string | null }[];
}

export interface PackageAssembly {
  id: string;
  label: string;
  number: number;
  type: AssemblyType;
  startDate: Date;
  endDate: Date;
  location: string;
  agendaFinal: boolean;
  convocationIntro: string | null;
  /** The signed convocatoria's URL and its name on disk. */
  convocationFileUrl: string | null;
  convocationStoredFile: string | null;
  milestones: { key: string; at: Date; note: string | null }[];
}

export interface PackageSource {
  assembly: PackageAssembly;
  /** The numbered items, depth first. */
  items: PackageItem[];
  /** Published documents, in agenda order. */
  documents: PackageDocument[];
}

export type PieceSpec =
  /** An uploaded PDF, copied as it is. */
  | { kind: "file"; stored: string }
  | { kind: "convocation" }
  | { kind: "agenda" }
  | {
      kind: "document";
      documentId: string;
      version: "base" | "consolidated";
      format: "pdf" | "docx";
    }
  | { kind: "amendment"; documentId: string; amendmentId: string };

export interface PackageEntry {
  /** Path inside the ZIP, with "/" between folders. */
  path: string;
  piece: PieceSpec;
  /** The piece's key: file pieces by their name on disk, the others by a hash. */
  key: string;
}

/**
 * What the ZIP shows, by identity. A ZIP built for an earlier state is only
 * handed out while all of it is still public, as it was (packageStillPublic).
 */
export interface PackageIncludes {
  documents: {
    id: string;
    baseVersionId: string | null;
    consolidatedVersionId: string | null;
    fileUrl: string | null;
  }[];
  amendmentIds: string[];
  convocationFileUrl: string | null;
}

export interface PackagePlan {
  /** The folder everything sits in, which names the ZIP too. */
  root: string;
  entries: PackageEntry[];
  fingerprint: string;
  includes: PackageIncludes;
}

export interface PackageOptions {
  locale: ExportLocale;
  /** Adds the Word version of every text. */
  editable: boolean;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pieceKey(locale: ExportLocale, kind: string, inputs: unknown): string {
  return hash([PACKAGE_RENDERER_VERSION, locale, kind, inputs]).slice(0, 40);
}

function assemblyInputs(assembly: PackageAssembly) {
  return {
    label: assembly.label,
    number: assembly.number,
    type: assembly.type,
    startDate: assembly.startDate.toISOString(),
    endDate: assembly.endDate.toISOString(),
    location: assembly.location,
    agendaFinal: assembly.agendaFinal,
  };
}

function voteInputs(vote: ExportVote | null) {
  return vote ? { ...vote, recordedAt: vote.recordedAt.toISOString() } : null;
}

function documentName(document: PackageDocument): string {
  return safeName(
    document.reference
      ? `${document.reference} ${document.title}`
      : document.title,
    FILE_TITLE_MAX,
  );
}

/** The package of `source`: every path, every piece and the fingerprint. */
export function planPackage(
  source: PackageSource,
  options: PackageOptions,
  t: Translate,
): PackagePlan {
  const { assembly } = source;
  const { locale } = options;
  const root = safeName(t("package.root", { assembly: assembly.label }), 80);
  const entries: PackageEntry[] = [];
  const add = (path: string, piece: PieceSpec, key: string) =>
    entries.push({ path, piece, key });

  const rootNames = new NameRegistry();
  const rows = source.items.map((item) => ({
    numbering: item.numbering,
    title: item.title,
    depth: item.depth,
    documents: item.documents,
  }));
  if (assembly.convocationStoredFile) {
    add(
      `${root}/${rootNames.claim(`00 ${t("package.convocation")}`, ".pdf")}`,
      { kind: "file", stored: assembly.convocationStoredFile },
      `file:${assembly.convocationStoredFile}`,
    );
  } else {
    add(
      `${root}/${rootNames.claim(`00 ${t("package.convocation")}`, ".pdf")}`,
      { kind: "convocation" },
      pieceKey(locale, "convocation", {
        assembly: assemblyInputs(assembly),
        intro: assembly.convocationIntro,
        milestones: assembly.milestones.map((milestone) => ({
          ...milestone,
          at: milestone.at.toISOString(),
        })),
        rows,
      }),
    );
  }
  add(
    `${root}/${rootNames.claim(`00 ${t("package.agenda")}`, ".pdf")}`,
    { kind: "agenda" },
    pieceKey(locale, "agenda", {
      assembly: assemblyInputs(assembly),
      rows: rows.map(({ documents: _, ...row }) => row),
    }),
  );

  // Folders: an item gets one only when something under it is in the
  // package; its path follows the agenda's numbers.
  const itemById = new Map(source.items.map((item) => [item.id, item]));
  const documentsByItem = new Map<string, PackageDocument[]>();
  for (const document of source.documents) {
    if (!itemById.has(document.agendaItemId)) continue;
    const list = documentsByItem.get(document.agendaItemId) ?? [];
    list.push(document);
    documentsByItem.set(document.agendaItemId, list);
  }
  const folders = new Map<string, string>();
  const folderNames = new Map<string, NameRegistry>([[root, rootNames]]);
  const registry = (folder: string) => {
    let names = folderNames.get(folder);
    if (!names) {
      names = new NameRegistry();
      folderNames.set(folder, names);
    }
    return names;
  };
  const folderOf = (item: PackageItem): string => {
    const known = folders.get(item.id);
    if (known) return known;
    const parent = item.parentId ? itemById.get(item.parentId) : undefined;
    const parentFolder = parent ? folderOf(parent) : root;
    const title = item.title ?? t("agendaHiddenTitle");
    const name = registry(parentFolder).claim(
      safeName(
        `${sortableNumbering(item.numbering)} ${safeName(title, FOLDER_TITLE_MAX)}`,
        FOLDER_TITLE_MAX + 12,
      ),
    );
    const folder = `${parentFolder}/${name}`;
    folders.set(item.id, folder);
    return folder;
  };

  const includes: PackageIncludes = {
    documents: [],
    amendmentIds: [],
    convocationFileUrl: assembly.convocationFileUrl,
  };

  for (const item of source.items) {
    const documents = documentsByItem.get(item.id) ?? [];
    if (documents.length === 0) continue;
    const folder = folderOf(item);
    const names = registry(folder);
    const withAmendments = documents.filter(
      (document) =>
        document.format === "structured" && document.amendments.length > 0,
    );
    for (const document of documents) {
      const name = documentName(document);
      if (document.format === "file") {
        if (!document.storedFile) continue;
        add(
          `${folder}/${names.claim(name, ".pdf")}`,
          { kind: "file", stored: document.storedFile },
          `file:${document.storedFile}`,
        );
        includes.documents.push({
          id: document.id,
          baseVersionId: null,
          consolidatedVersionId: null,
          fileUrl: document.fileUrl,
        });
        continue;
      }
      if (!document.baseVersionId) continue;
      const meta = {
        title: document.title,
        reference: document.reference,
        kind: document.kind,
        proponent: document.proponent,
        assembly: assemblyInputs(assembly),
      };
      const versions: {
        version: "base" | "consolidated";
        versionId: string;
        name: string;
        vote: ExportVote | null;
      }[] = [
        // The text as presented carries no approval: only the consolidated
        // one, once voted, says how it was approved.
        {
          version: "base",
          versionId: document.baseVersionId,
          name,
          vote: null,
        },
      ];
      if (document.consolidatedVersionId) {
        versions.push({
          version: "consolidated",
          versionId: document.consolidatedVersionId,
          name: `${name} (${t("package.consolidated")})`,
          vote: document.finalVote,
        });
      }
      for (const entry of versions) {
        const formats: ("pdf" | "docx")[] = options.editable
          ? ["pdf", "docx"]
          : ["pdf"];
        for (const format of formats) {
          add(
            `${folder}/${names.claim(entry.name, `.${format}`)}`,
            {
              kind: "document",
              documentId: document.id,
              version: entry.version,
              format,
            },
            pieceKey(locale, `document-${format}`, {
              ...meta,
              versionId: entry.versionId,
              vote: voteInputs(entry.vote),
            }),
          );
        }
      }
      includes.documents.push({
        id: document.id,
        baseVersionId: document.baseVersionId,
        consolidatedVersionId: document.consolidatedVersionId,
        fileUrl: null,
      });

      if (document.amendments.length === 0) continue;
      const amendmentsFolder = `${folder}/${names.claim(
        withAmendments.length > 1
          ? safeName(`${t("package.amendments")} ${name}`, FILE_TITLE_MAX + 12)
          : t("package.amendments"),
      )}`;
      const amendmentNames = registry(amendmentsFolder);
      for (const amendment of document.amendments) {
        const label =
          amendment.code ??
          (amendment.number !== null ? String(amendment.number) : amendment.id);
        add(
          `${amendmentsFolder}/${amendmentNames.claim(safeName(label), ".pdf")}`,
          {
            kind: "amendment",
            documentId: document.id,
            amendmentId: amendment.id,
          },
          pieceKey(locale, "amendment", {
            ...amendment,
            updatedAt: amendment.updatedAt.toISOString(),
            document: meta,
            baseVersionId: document.baseVersionId,
          }),
        );
        includes.amendmentIds.push(amendment.id);
      }
    }
  }

  return {
    root,
    entries,
    includes,
    fingerprint: hash([
      PACKAGE_RENDERER_VERSION,
      locale,
      options.editable,
      entries.map((entry) => [entry.path, entry.key]),
    ]).slice(0, 32),
  };
}

/**
 * Whether everything an older package shows is still public as it was: the
 * same documents with the same texts and PDFs, the same amendments, the
 * same signed convocatoria. A ZIP that fails it is never handed out (a
 * document sent back to its presenters, an amendment unpublished, a PDF
 * replaced, which only managers read once replaced).
 */
export function packageStillPublic(
  shown: PackageIncludes,
  now: PackageIncludes,
): boolean {
  if (shown.convocationFileUrl !== now.convocationFileUrl) return false;
  const documents = new Map(
    now.documents.map((document) => [document.id, document]),
  );
  const sameDocuments = shown.documents.every((document) => {
    const current = documents.get(document.id);
    return (
      current !== undefined &&
      current.baseVersionId === document.baseVersionId &&
      current.fileUrl === document.fileUrl &&
      (document.consolidatedVersionId === null ||
        current.consolidatedVersionId === document.consolidatedVersionId)
    );
  });
  if (!sameDocuments) return false;
  const amendments = new Set(now.amendmentIds);
  return shown.amendmentIds.every((id) => amendments.has(id));
}

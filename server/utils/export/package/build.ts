import { createReadStream, createWriteStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import JSZip from "jszip";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { db } from "../../../db";
import { amendments } from "../../../db/schema";
import type { Block } from "../../../../shared/types/content";
import { fillApprovalLines } from "../../../../shared/utils/content/approvalLine";
import { previewAmendment } from "../../../../shared/utils/content/consolidate";
import { getUploadDir } from "../../core/uploadPaths";
import { logInfo, logWarn } from "../../core/logger";
import { loadBrand, loadPdfFonts } from "../assets";
import type { ExportBrand } from "../brand";
import { loadExportImages, loadVersionBlocks } from "../buildData";
import { buildDocumentDocx } from "../docxWriter";
import { createTranslator, type ExportLocale } from "../labels";
import {
  amendmentLocations,
  amendmentTypology,
  buildAgendaPdf,
  buildAmendmentPdf,
  buildConvocationPdf,
  type PackageAgendaRow,
  type PackagePdfAssembly as PdfAssembly,
} from "../packagePdf";
import { buildDocumentPdf, type ExportDocumentMeta } from "../pdfBuilder";
import { renderPdfBatch } from "../pdfRender";
import type { PackageJobData } from "../queue";
import { loadPackageSource } from "./load";
import {
  planPackage,
  type PackageDocument,
  type PackageEntry,
  type PackagePlan,
  type PackageSource,
} from "./plan";
import {
  assemblyPackageDir,
  ensurePackageDirs,
  fileExists,
  packageVariant,
  piecePath,
  readPackageState,
  sweepPackageDir,
  writeAtomically,
  writePackageState,
  zipFileName,
} from "./storage";

/**
 * Builds the documentation package of an assembly (one language, with or
 * without the Word versions): plans it from the current public state,
 * renders the pieces it does not have yet, one render at a time and in
 * order (each takes the render slot on its own, so a single export the Mesa
 * asks for meanwhile waits for one piece at most), and writes the ZIP. A
 * package whose fingerprint was already built is not built again.
 */

/** Short PDFs rendered in one render process (renderPdfBatch). */
const AMENDMENT_BATCH = 20;

export type PackageProgress = (done: number, total: number) => void;

export interface BuiltPackage {
  status: "built" | "current" | "hidden";
  fingerprint?: string;
}

export async function planCurrentPackage(
  assemblyId: string,
  locale: ExportLocale,
  editable: boolean,
): Promise<{ source: PackageSource; plan: PackagePlan } | null> {
  const source = await loadPackageSource(assemblyId);
  if (!source) return null;
  return {
    source,
    plan: planPackage(source, { locale, editable }, createTranslator(locale)),
  };
}

function extensionOf(entry: PackageEntry): "pdf" | "docx" {
  return entry.piece.kind === "document" && entry.piece.format === "docx"
    ? "docx"
    : "pdf";
}

/** Where a piece's file is: an uploaded PDF, or a rendered piece. */
function sourcePath(assemblyId: string, entry: PackageEntry): string {
  return entry.piece.kind === "file"
    ? join(getUploadDir(), entry.piece.stored)
    : piecePath(assemblyId, entry.key, extensionOf(entry));
}

export async function buildPackage(
  job: PackageJobData,
  onProgress: PackageProgress = () => undefined,
): Promise<BuiltPackage> {
  const started = performance.now();
  const planned = await planCurrentPackage(
    job.assemblyId,
    job.locale,
    job.editable,
  );
  if (!planned) return { status: "hidden" };
  const { source, plan } = planned;
  const variant = packageVariant(job.editable);
  const dir = assemblyPackageDir(job.assemblyId);
  const zipName = zipFileName(job.locale, variant, plan.fingerprint);

  const state = await readPackageState(job.assemblyId, job.locale, variant);
  if (
    state?.fingerprint === plan.fingerprint &&
    (await fileExists(join(dir, zipName)))
  ) {
    return { status: "current", fingerprint: plan.fingerprint };
  }
  await ensurePackageDirs(job.assemblyId);

  // Pieces to render: each key once, those not on disk yet.
  const missing: PackageEntry[] = [];
  const seen = new Set<string>();
  for (const entry of plan.entries) {
    if (entry.piece.kind === "file" || seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (!(await fileExists(sourcePath(job.assemblyId, entry)))) {
      missing.push(entry);
    }
  }
  let done = 0;
  onProgress(done, missing.length);
  const renderer = new PieceRenderer(source, job.locale, await loadBrand());
  for (const group of renderGroups(missing)) {
    await renderer.render(job.assemblyId, group);
    done += group.length;
    onProgress(done, missing.length);
  }

  // Uploaded PDFs missing on disk are left out rather than failing it all.
  const entries: PackageEntry[] = [];
  for (const entry of plan.entries) {
    if (await fileExists(sourcePath(job.assemblyId, entry)))
      entries.push(entry);
    else {
      logWarn("package.build", {
        reason: "piece missing",
        assemblyId: job.assemblyId,
        kind: entry.piece.kind,
      });
    }
  }

  const bytes = await writeZip(job.assemblyId, entries, join(dir, zipName));
  await writePackageState(job.assemblyId, job.locale, variant, {
    fingerprint: plan.fingerprint,
    zipFile: zipName,
    root: plan.root,
    builtAt: new Date().toISOString(),
    bytes,
    includes: plan.includes,
    pieces: [
      ...new Set(
        entries
          .filter((entry) => entry.piece.kind !== "file")
          .map((entry) => entry.key),
      ),
    ],
  });
  await sweepPackageDir(job.assemblyId);
  logInfo("package.build", {
    assemblyId: job.assemblyId,
    locale: job.locale,
    variant,
    files: entries.length,
    rendered: missing.length,
    bytes,
    ms: Math.round(performance.now() - started),
  });
  return { status: "built", fingerprint: plan.fingerprint };
}

/**
 * The order pieces are rendered in, grouped: a document's amendments in
 * batches (short PDFs sharing a render process), everything else alone.
 */
function renderGroups(missing: PackageEntry[]): PackageEntry[][] {
  const groups: PackageEntry[][] = [];
  const amendmentsByDocument = new Map<string, PackageEntry[]>();
  for (const entry of missing) {
    if (entry.piece.kind === "amendment") {
      const list = amendmentsByDocument.get(entry.piece.documentId) ?? [];
      list.push(entry);
      amendmentsByDocument.set(entry.piece.documentId, list);
    } else groups.push([entry]);
  }
  for (const list of amendmentsByDocument.values()) {
    for (let i = 0; i < list.length; i += AMENDMENT_BATCH) {
      groups.push(list.slice(i, i + AMENDMENT_BATCH));
    }
  }
  return groups;
}

/** Writes the ZIP: stored, not compressed (PDFs and DOCX already are), streamed. */
async function writeZip(
  assemblyId: string,
  entries: PackageEntry[],
  path: string,
): Promise<number> {
  const zip = new JSZip();
  const date = new Date();
  for (const entry of entries) {
    zip.file(entry.path, createReadStream(sourcePath(assemblyId, entry)), {
      binary: true,
      date,
    });
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await pipeline(
      zip.generateNodeStream({
        type: "nodebuffer",
        streamFiles: true,
        compression: "STORE",
      }),
      createWriteStream(temporary),
    );
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return (await stat(path)).size;
}

// Rendering -------------------------------------------------------------------

class PieceRenderer {
  private readonly documents: Map<string, PackageDocument>;
  private readonly pdfAssembly: PdfAssembly;
  private readonly agendaRows: PackageAgendaRow[];

  constructor(
    private readonly source: PackageSource,
    private readonly locale: ExportLocale,
    private readonly brand: ExportBrand,
  ) {
    this.documents = new Map(source.documents.map((d) => [d.id, d]));
    const { assembly } = source;
    this.pdfAssembly = {
      label: assembly.label,
      number: assembly.number,
      type: assembly.type,
      startDate: assembly.startDate,
      endDate: assembly.endDate,
      location: assembly.location,
      agendaFinal: assembly.agendaFinal,
    };
    this.agendaRows = source.items.map((item) => ({
      numbering: item.numbering,
      title: item.title,
      depth: item.depth,
      documents: item.documents,
    }));
  }

  async render(assemblyId: string, group: PackageEntry[]): Promise<void> {
    const first = group[0]!;
    const piece = first.piece;
    if (piece.kind === "document" && piece.format === "docx") {
      const buffer = await this.documentDocx(piece.documentId, piece.version);
      await writeAtomically(piecePath(assemblyId, first.key, "docx"), buffer);
      return;
    }
    const definitions: TDocumentDefinitions[] = [];
    for (const entry of group) definitions.push(await this.definition(entry));
    const { pdfs } = await renderPdfBatch(definitions, await loadPdfFonts());
    for (const [index, entry] of group.entries()) {
      await writeAtomically(
        piecePath(assemblyId, entry.key, "pdf"),
        pdfs[index]!,
      );
    }
  }

  private async definition(entry: PackageEntry): Promise<TDocumentDefinitions> {
    const piece = entry.piece;
    switch (piece.kind) {
      case "agenda":
        return buildAgendaPdf(
          { assembly: this.pdfAssembly, rows: this.agendaRows },
          this.locale,
          this.brand,
        );
      case "convocation":
        return buildConvocationPdf(
          {
            assembly: this.pdfAssembly,
            intro: this.source.assembly.convocationIntro,
            rows: this.agendaRows,
            milestones: this.source.assembly.milestones,
          },
          this.locale,
          this.brand,
        );
      case "document":
        return this.documentPdf(piece.documentId, piece.version);
      case "amendment":
        return this.amendmentPdf(piece.documentId, piece.amendmentId);
      case "file":
        throw new Error("Uploaded files are not rendered");
    }
  }

  private document(id: string): PackageDocument {
    const document = this.documents.get(id);
    if (!document) throw new Error("Package document not loaded");
    return document;
  }

  private async text(
    document: PackageDocument,
    version: "base" | "consolidated",
  ): Promise<Block[]> {
    const versionId =
      version === "base"
        ? document.baseVersionId
        : document.consolidatedVersionId;
    if (!versionId) throw new Error("Package document has no such version");
    const blocks = (await loadVersionBlocks([versionId])).get(versionId) ?? [];
    // The template's approval line: filled in on the consolidated text once
    // approved, left out of the text as presented (as the PDF does).
    const vote = version === "consolidated" ? document.finalVote : null;
    return fillApprovalLines(
      blocks,
      vote?.result === "approved"
        ? {
            assembly: {
              number: this.source.assembly.number,
              type: this.source.assembly.type,
            },
            vote,
          }
        : null,
    ).blocks;
  }

  private meta(
    document: PackageDocument,
    version: "base" | "consolidated",
  ): ExportDocumentMeta {
    return {
      title: document.title,
      reference: document.reference,
      kind: document.kind,
      format: document.format,
      proponent: document.proponent,
      fileName: null,
      agendaNumbering: null,
      agendaTitle: null,
      finalVote: version === "consolidated" ? document.finalVote : null,
    };
  }

  private async documentPdf(
    documentId: string,
    version: "base" | "consolidated",
  ): Promise<TDocumentDefinitions> {
    const document = this.document(documentId);
    const versionId =
      version === "base"
        ? document.baseVersionId
        : document.consolidatedVersionId;
    const blocks =
      (await loadVersionBlocks([versionId!])).get(versionId!) ?? [];
    return buildDocumentPdf(
      {
        assembly: this.pdfAssembly,
        document: this.meta(document, version),
        body: { variant: "clean", source: version, blocks },
        generatedAt: new Date(),
        images: await loadExportImages([document.id], blocks),
      },
      this.locale,
      this.brand,
    );
  }

  private async documentDocx(
    documentId: string,
    version: "base" | "consolidated",
  ): Promise<Buffer> {
    const document = this.document(documentId);
    const blocks = await this.text(document, version);
    const t = createTranslator(this.locale);
    return buildDocumentDocx(
      {
        title: document.title || t("untitled"),
        assemblyLabel: this.source.assembly.label,
        pageCount: t("footer.page", { page: "{page}", total: "{total}" }),
        blocks,
        images: await loadExportImages([document.id], blocks),
      },
      this.brand,
    );
  }

  private baseCache = new Map<string, Block[]>();
  private amendmentCache = new Map<
    string,
    { ops: (typeof amendments.$inferSelect)["ops"]; justification: string }
  >();

  private async amendmentPdf(
    documentId: string,
    amendmentId: string,
  ): Promise<TDocumentDefinitions> {
    const document = this.document(documentId);
    const amendment = document.amendments.find((a) => a.id === amendmentId);
    if (!amendment || !document.baseVersionId) {
      throw new Error("Package amendment not loaded");
    }
    let base = this.baseCache.get(document.id);
    if (!base) {
      base =
        (await loadVersionBlocks([document.baseVersionId])).get(
          document.baseVersionId,
        ) ?? [];
      this.baseCache.set(document.id, base);
      // The document's amendments come together: read their text at once.
      const rows = await db
        .select({
          id: amendments.id,
          ops: amendments.ops,
          justification: amendments.justification,
        })
        .from(amendments)
        .where(
          inArray(
            amendments.id,
            document.amendments.map((a) => a.id),
          ),
        );
      for (const row of rows) this.amendmentCache.set(row.id, row);
    }
    const stored = this.amendmentCache.get(amendmentId);
    if (!stored) throw new Error("Package amendment not loaded");
    const fragment =
      stored.ops.length > 0
        ? previewAmendment(base, { id: amendmentId, ops: stored.ops })
        : [];
    return buildAmendmentPdf(
      {
        assembly: this.pdfAssembly,
        document: {
          title: document.title,
          reference: document.reference,
          kind: document.kind,
        },
        amendment: {
          code: amendment.code,
          kind: amendment.kind,
          status: amendment.status,
          approvalMethod: amendment.approvalMethod,
          authors: amendment.authors,
          sourceCodes: amendment.sourceCodes,
          transactedInto: amendment.transactedInto,
          justification: stored.justification,
        },
        typology: amendmentTypology(stored.ops),
        locations: amendmentLocations(base, stored.ops),
        fragment,
        images: await loadExportImages(
          [document.id],
          fragment.map((block) => ({ type: block.type, image: block.image })),
        ),
      },
      this.locale,
      this.brand,
    );
  }
}

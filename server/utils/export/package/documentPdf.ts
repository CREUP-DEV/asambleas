import type { TDocumentDefinitions } from "pdfmake/interfaces";
import type { ExportBrand } from "../brand";
import { loadExportImages, loadVersionBlocks } from "../buildData";
import type { ExportLocale } from "../labels";
import { pageLayoutKey, type PageLayoutInputs } from "../pageMap";
import {
  buildDocumentPdf,
  type ExportAssembly,
  type ExportDocumentMeta,
} from "../pdfBuilder";
import { PACKAGE_RENDERER_VERSION, type PackageDocument } from "./plan";

/**
 * A text's clean PDF as the documentation package renders it (build.ts),
 * shared with the job that reads its pages when the package has not
 * rendered it (documentPages.ts): both lay out the same definition.
 */

/** What a text's clean PDF reads of its document. */
export type CleanDocumentSource = Pick<
  PackageDocument,
  | "id"
  | "title"
  | "reference"
  | "kind"
  | "format"
  | "proponent"
  | "finalVote"
  | "pendingConciliation"
  | "baseVersionId"
  | "consolidatedVersionId"
>;

export function cleanDocumentMeta(
  document: CleanDocumentSource,
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
    pendingConciliation:
      version === "consolidated" ? (document.pendingConciliation ?? []) : [],
  };
}

export function cleanDocumentVersionId(
  document: CleanDocumentSource,
  version: "base" | "consolidated",
): string | null {
  return version === "base"
    ? document.baseVersionId
    : document.consolidatedVersionId;
}

/**
 * The definition of a text's clean PDF, and its blocks' ids in order. With
 * `pageTags`, its blocks carry their ids for the pages the render reads
 * back (the PDF comes out the same).
 */
export async function cleanDocumentDefinition(
  assembly: ExportAssembly,
  document: CleanDocumentSource,
  version: "base" | "consolidated",
  locale: ExportLocale,
  brand: ExportBrand,
  options: { pageTags?: boolean; justified?: boolean } = {},
): Promise<{ definition: TDocumentDefinitions; order: string[] }> {
  const versionId = cleanDocumentVersionId(document, version);
  if (!versionId) throw new Error("Package document has no such version");
  const blocks = (await loadVersionBlocks([versionId])).get(versionId) ?? [];
  const definition = buildDocumentPdf(
    {
      assembly,
      document: cleanDocumentMeta(document, version),
      body: { variant: "clean", source: version, blocks },
      generatedAt: new Date(),
      images: await loadExportImages([document.id], blocks),
    },
    locale,
    brand,
    options,
  );
  return { definition, order: blocks.map((block) => block.id) };
}

/** The key a map of this text's pages is valid for (pageLayoutKey). */
export function cleanDocumentPageKey(
  assembly: Pick<ExportAssembly, "label" | "number" | "type">,
  document: CleanDocumentSource,
  version: "base" | "consolidated",
  locale: ExportLocale,
): { versionId: string; key: string } | null {
  const versionId = cleanDocumentVersionId(document, version);
  if (!versionId) return null;
  const inputs: PageLayoutInputs = {
    locale,
    versionId,
    version,
    title: document.title,
    kind: document.kind,
    assembly: {
      label: assembly.label,
      number: assembly.number,
      type: assembly.type,
    },
    finalVote: version === "consolidated" ? document.finalVote : null,
    pendingConciliation:
      version === "consolidated" ? (document.pendingConciliation ?? []) : [],
  };
  return { versionId, key: pageLayoutKey(inputs, PACKAGE_RENDERER_VERSION) };
}

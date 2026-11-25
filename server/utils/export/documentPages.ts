import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { assemblies, documentPageMaps, documents } from "../../db/schema";
import type { DocumentPagesDto, PageMapDto } from "../../../shared/types/api";
import { isPublicDocumentStatus } from "../../../shared/utils/agendaSubmissions";
import { logInfo, logWarn } from "../core/logger";
import { loadBrand, loadPdfFonts } from "./assets";
import { hasCover } from "./brand";
import {
  loadPendingConciliation,
  loadVotes,
  toExportAssembly,
  toExportVote,
} from "./buildData";
import type { ExportLocale } from "./labels";
import {
  cleanDocumentDefinition,
  cleanDocumentPageKey,
  type CleanDocumentSource,
} from "./package/documentPdf";
import { pagesJobStartAfter, pagesRetryAfter } from "./package/prebuild";
import { buildPageMap, type RawPages } from "./pageMap";
import type { ExportAssembly } from "./pdfBuilder";
import { renderPdfBatch } from "./pdfRender";
import {
  DOCUMENT_PAGES_QUEUE_NAME,
  getExportQueue,
  type DocumentPagesJobData,
} from "./queue";

/**
 * The pages of a text's clean PDF, for the web text (user's decisions of
 * 2026-11-21; pageMap.ts). The reference is the documentation package's
 * Spanish PDF: the text as presented (the base version, no vote) and,
 * once voted, the consolidated one (corrected or conciliated versions
 * included). The package stores the map whenever it renders one of them
 * (build.ts); for a text it has not rendered, a reader's request queues the
 * `document-pages` job, which lays out the same definition.
 */

/** Only the Spanish PDF is read: every interface shows its numbers. */
export const PAGE_MAP_LOCALE: ExportLocale = "es";

type DocumentRow = typeof documents.$inferSelect;
type AssemblyRow = typeof assemblies.$inferSelect;

type Version = "base" | "consolidated";
const VERSIONS: Version[] = ["base", "consolidated"];

/** Stores the map of a text's render; a failure only leaves it missing. */
export async function storeDocumentPages(
  assembly: Pick<ExportAssembly, "label" | "number" | "type">,
  document: CleanDocumentSource,
  version: Version,
  locale: ExportLocale,
  order: readonly string[],
  raw: RawPages,
): Promise<void> {
  const target = cleanDocumentPageKey(assembly, document, version, locale);
  if (!target) return;
  try {
    const map = buildPageMap(order, raw, hasCover(document.kind) ? 1 : 0);
    const values = {
      layoutKey: target.key,
      totalPages: map.total,
      starts: map.starts,
      createdAt: new Date(),
    };
    await db
      .insert(documentPageMaps)
      .values({ versionId: target.versionId, locale, ...values })
      .onConflictDoUpdate({
        target: [documentPageMaps.versionId, documentPageMaps.locale],
        set: values,
      });
  } catch (error) {
    logWarn("document-pages.store", {
      documentId: document.id,
      version,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * What a text's PDF is built from, as the package reads it, or null for a
 * document the package does not hold (not public, that is published or
 * postponed, or an uploaded PDF). The presenters are left out: the PDF's
 * layout does not depend on them.
 */
async function pageSource(
  assembly: AssemblyRow,
  document: DocumentRow,
): Promise<{ assembly: ExportAssembly; document: CleanDocumentSource } | null> {
  if (
    !isPublicDocumentStatus(document.status) ||
    document.format !== "structured"
  ) {
    return null;
  }
  const [votes, pending] = await Promise.all([
    loadVotes([document.finalVoteId]),
    loadPendingConciliation([document.consolidatedVersionId]),
  ]);
  const vote = document.finalVoteId ? votes.get(document.finalVoteId) : null;
  return {
    assembly: toExportAssembly(assembly),
    document: {
      id: document.id,
      title: document.title,
      reference: document.reference,
      kind: document.kind,
      format: document.format,
      proponent: null,
      finalVote: vote ? toExportVote(vote) : null,
      pendingConciliation: document.consolidatedVersionId
        ? (pending.get(document.consolidatedVersionId) ?? [])
        : [],
      baseVersionId: document.baseVersionId,
      consolidatedVersionId: document.consolidatedVersionId,
    },
  };
}

/**
 * Jobs this process queued lately, by key: when (ms) and their `startAfter`
 * (seconds, undefined when they run at once or it is not known). A reader
 * polling asks once. A job that ends with the map current forgets its key,
 * so a map overwritten afterwards (a package build from an older snapshot)
 * is asked for again.
 */
const queued = new Map<string, { at: number; startAfter?: number }>();
/** How long a queued (or failed) job keeps the same request from queueing. */
const REQUEUE_AFTER_MS = 10 * 60 * 1000;

function queuedKey(target: { versionId: string; key: string }): string {
  return `${target.versionId}:${target.key}`;
}

/**
 * Queues the job for a missing map unless this process did lately, and
 * answers the seconds a reader may wait before asking again (its
 * `retryAfter`, pagesRetryAfter).
 */
async function queuePages(
  documentId: string,
  version: Version,
  key: string,
  assemblyStatus: string,
): Promise<number> {
  const now = Date.now();
  for (const [entry, { at }] of queued) {
    if (now - at > REQUEUE_AFTER_MS) queued.delete(entry);
  }
  const known = queued.get(key);
  if (known) return pagesRetryAfter(known.at, known.startAfter, now);
  // Where the package is built ahead, after its prebuild (prebuild.ts).
  const startAfter = pagesJobStartAfter(assemblyStatus);
  queued.set(key, { at: now, startAfter });
  try {
    const boss = await getExportQueue();
    const data: DocumentPagesJobData = { documentId, version };
    const id = await boss.send(DOCUMENT_PAGES_QUEUE_NAME, data, {
      singletonKey: key,
      ...(startAfter === undefined ? {} : { startAfter }),
    });
    // Null when a job of that key was already queued (another process, or
    // this one before a restart): when it runs is unknown, so the floor.
    if (id === null) queued.set(key, { at: now });
  } catch (error) {
    queued.set(key, { at: now });
    logWarn("document-pages.queue", {
      documentId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const entry = queued.get(key);
  return pagesRetryAfter(now, entry?.startAfter, now);
}

/**
 * The pages of a document's texts for a reader who sees it (the route
 * checked it): a stored map only while its key matches the text as the PDF
 * would show it now. A missing one is queued and reads as `pending`, with
 * the seconds until the soonest of its jobs may run as `retryAfter`.
 */
export async function loadDocumentPages(
  assembly: AssemblyRow,
  document: DocumentRow,
): Promise<DocumentPagesDto> {
  const none: DocumentPagesDto = {
    base: null,
    consolidated: null,
    pending: false,
  };
  const source = await pageSource(assembly, document);
  if (!source) return none;
  const targets = VERSIONS.flatMap((version) => {
    const target = cleanDocumentPageKey(
      source.assembly,
      source.document,
      version,
      PAGE_MAP_LOCALE,
    );
    return target ? [{ version, ...target }] : [];
  });
  if (targets.length === 0) return none;
  const rows = await db
    .select()
    .from(documentPageMaps)
    .where(
      and(
        inArray(
          documentPageMaps.versionId,
          targets.map((target) => target.versionId),
        ),
        eq(documentPageMaps.locale, PAGE_MAP_LOCALE),
      ),
    );
  const result: DocumentPagesDto = { ...none };
  for (const target of targets) {
    const row = rows.find(
      (candidate) =>
        candidate.versionId === target.versionId &&
        candidate.layoutKey === target.key,
    );
    if (row) {
      const map: PageMapDto = {
        versionId: row.versionId,
        total: row.totalPages,
        starts: row.starts,
      };
      result[target.version] = map;
    } else {
      result.pending = true;
      const retryAfter = await queuePages(
        document.id,
        target.version,
        queuedKey(target),
        assembly.status,
      );
      result.retryAfter = Math.min(result.retryAfter ?? retryAfter, retryAfter);
    }
  }
  return result;
}

/**
 * The `document-pages` job: renders the text's PDF as the package would,
 * with its blocks tagged, and stores where its pages start. Nothing to do
 * when the document is gone or no longer public, or the map is current.
 */
export async function processDocumentPagesJob(
  data: DocumentPagesJobData,
): Promise<void> {
  const document = await db.query.documents.findFirst({
    where: eq(documents.id, data.documentId),
  });
  if (!document) return;
  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, document.assemblyId),
  });
  if (!assembly) return;
  const source = await pageSource(assembly, document);
  if (!source) return;
  const target = cleanDocumentPageKey(
    source.assembly,
    source.document,
    data.version,
    PAGE_MAP_LOCALE,
  );
  if (!target) return;
  const isCurrent = async () => {
    const [current] = await db
      .select({ layoutKey: documentPageMaps.layoutKey })
      .from(documentPageMaps)
      .where(
        and(
          eq(documentPageMaps.versionId, target.versionId),
          eq(documentPageMaps.locale, PAGE_MAP_LOCALE),
        ),
      );
    return current?.layoutKey === target.key;
  };
  if (await isCurrent()) {
    queued.delete(queuedKey(target));
    return;
  }

  const started = Date.now();
  const { definition, order } = await cleanDocumentDefinition(
    source.assembly,
    source.document,
    data.version,
    PAGE_MAP_LOCALE,
    await loadBrand(),
    { pageTags: true },
  );
  // Asked again once the render slot is free: a package build that held it
  // may have stored this very map meanwhile.
  const { pages, skipped } = await renderPdfBatch(
    [definition],
    await loadPdfFonts(),
    undefined,
    { pages: true, stillNeeded: async () => !(await isCurrent()) },
  );
  if (skipped) {
    queued.delete(queuedKey(target));
    return;
  }
  if (!pages?.[0]) return;
  await storeDocumentPages(
    source.assembly,
    source.document,
    data.version,
    PAGE_MAP_LOCALE,
    order,
    pages[0],
  );
  queued.delete(queuedKey(target));
  logInfo("document-pages.job", {
    documentId: document.id,
    version: data.version,
    blocks: order.length,
    pages: pages[0].total,
    ms: Date.now() - started,
  });
}

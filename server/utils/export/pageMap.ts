import { createHash } from "node:crypto";
import type { PageMapStart } from "../../../shared/types/api";
import type { ExportLocale } from "./labels";
import type { ExportVote } from "./pdfBuilder";

/**
 * The pages of a document's clean PDF, block by block (user's decisions of
 * 2026-11-21): the web text shows «pág. N» where each printed page starts.
 * The documentation package's PDFs are the reference: a text's PDF is
 * rendered with its blocks tagged (content.ts, PageTag), the render process
 * reads back on which pages each tagged node was laid out (pdfRender.ts)
 * and this module turns that into the page starts stored per version
 * (document_page_maps), with a key of everything that moves the layout.
 */

/**
 * The prefix of the pdfmake ids page tags add: pdfmake corrects the page of
 * a node laid out in an unbreakable table row only when it has an id. The
 * render process drops them as named destinations (pdfRender.ts), so the
 * PDF's bytes stay those of an untagged render.
 */
export const PAGE_TAG_PREFIX = "pgtag-";

/**
 * What a tagged node carries (`pageTag`): its block, and whether it sits in
 * a table's cell (only its first position's page is right) or in a header
 * row (repeated on every page, so its position is the last repetition's).
 */
export interface PageTag {
  b: string;
  cell?: 1;
  header?: 1;
}

/**
 * One tagged node as the render process reads it back: block id, first and
 * last absolute page (1-based, the cover included; null when unknown) and
 * 1 for a node in a table's header row.
 */
export type RawPageTag = [
  blockId: string,
  first: number | null,
  last: number | null,
  header: 0 | 1,
];

/** What the render process answers for a definition with page tags. */
export interface RawPages {
  /** Pages of the PDF, the cover included. */
  total: number;
  tags: RawPageTag[];
}

/** A version's pages as the footer prints them. */
export interface PageMap {
  /** Printed pages: the cover is not counted («3 de 12»). */
  total: number;
  starts: PageMapStart[];
}

/**
 * Bumped whenever the way pages are read or placed changes: every stored
 * map is computed again.
 */
export const PAGE_MAP_VERSION = 1;

/**
 * Where each printed page starts, from the tagged nodes of a render.
 *
 * - `order` is the text's blocks in order; a block's pages span its nodes.
 * - A block whose page is unknown (an image in a table's cell, a header
 *   row) takes the next known block's first page when in a header row
 *   (it is laid out with the row after it), else the previous one's last.
 * - `firstPage` pages are not counted (1 for a positioning's cover): a
 *   printed page `p` is absolute page `p + firstPage`.
 * - Page `p` starts inside the block that runs on from an earlier page
 *   (`inside`: the marker goes beside it), else at the first block that
 *   starts on it. A page holding no block (the links' list) has no start.
 */
export function buildPageMap(
  order: readonly string[],
  raw: RawPages,
  firstPage: number,
): PageMap {
  const known = new Map<
    string,
    { first: number | null; last: number | null; header: boolean }
  >();
  for (const [blockId, first, last, header] of raw.tags) {
    const entry = known.get(blockId) ?? {
      first: null,
      last: null,
      header: false,
    };
    if (first !== null) {
      entry.first = entry.first === null ? first : Math.min(entry.first, first);
    }
    if (last !== null) {
      entry.last = entry.last === null ? last : Math.max(entry.last, last);
    }
    entry.header ||= header === 1;
    known.set(blockId, entry);
  }
  // The blocks laid out, in the text's order.
  const blocks = order
    .filter((id) => known.has(id))
    .map((id) => ({ id, ...known.get(id)! }));
  // Unknown pages from the neighbours.
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (block.first !== null) {
      block.last ??= block.first;
      continue;
    }
    const next = blocks.slice(i + 1).find((other) => other.first !== null);
    const previous = blocks
      .slice(0, i)
      .reverse()
      .find((other) => other.first !== null);
    const page = block.header
      ? (next?.first ?? previous?.last ?? null)
      : (previous?.last ?? next?.first ?? null);
    block.first = page;
    block.last = page;
  }
  const starts: PageMapStart[] = [];
  // The first printed page no block has started yet.
  let next = 1;
  for (const block of blocks) {
    if (block.first === null || block.last === null) continue;
    const first = Math.max(1, block.first - firstPage);
    const last = block.last - firstPage;
    // Every page it lies on already starts with an earlier block.
    if (last < next) continue;
    for (let page = Math.max(next, first); page <= last; page += 1) {
      starts.push({ blockId: block.id, page, inside: page > first });
    }
    next = last + 1;
  }
  const total = Math.max(0, raw.total - firstPage, next - 1);
  return { total, starts };
}

/** The final vote as the PDF prints it (the vote line, the approval fill). */
function voteKey(vote: ExportVote | null) {
  if (!vote) return null;
  return {
    result: vote.result,
    method: vote.method,
    majority: vote.majority,
    unanimous: vote.unanimous,
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
    blank: vote.blank,
    recordedAt: vote.recordedAt.toISOString(),
  };
}

/** Everything a clean text's PDF lays out from (its definition's inputs). */
export interface PageLayoutInputs {
  locale: ExportLocale;
  versionId: string;
  version: "base" | "consolidated";
  title: string;
  kind: string;
  assembly: { label: string; number: number; type: string };
  /** The consolidated text's final vote; the base text prints none. */
  finalVote: ExportVote | null;
  /** Passages left pending conciliation, as their notes print them. */
  pendingConciliation: { blockId: string | null; codes: string[] }[];
}

/**
 * The key a stored map is valid for: it changes with anything that moves the
 * PDF's layout (the text, its title or cover, the vote line or the filled
 * approval line, the notes of a passage pending conciliation, the language)
 * and with the renderer (PACKAGE_RENDERER_VERSION, PAGE_MAP_VERSION). A
 * map whose key no longer matches is never shown: no number is better than
 * a wrong one.
 */
export function pageLayoutKey(
  inputs: PageLayoutInputs,
  rendererVersion: number,
): string {
  const consolidated = inputs.version === "consolidated";
  return createHash("sha256")
    .update(
      JSON.stringify([
        PAGE_MAP_VERSION,
        rendererVersion,
        inputs.locale,
        inputs.versionId,
        inputs.version,
        inputs.title,
        inputs.kind,
        inputs.assembly.label,
        inputs.assembly.number,
        inputs.assembly.type,
        consolidated ? voteKey(inputs.finalVote) : null,
        consolidated ? inputs.pendingConciliation : [],
      ]),
    )
    .digest("hex")
    .slice(0, 40);
}

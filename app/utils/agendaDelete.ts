/**
 * What deleting an agenda item takes with it, and what keeps it from being
 * deleted. The server deletes an item with its sub-items and every document
 * under them; only amendments keep it (they are other members' work), and,
 * during the session, the item being dealt with right now.
 *
 * Every function is pure and never mutates its input.
 */

import {
  AGENDA_DELETE_AMENDMENTS_CODE,
  AGENDA_DELETE_LIVE_CODE,
} from "~~/shared/utils/agendaSubmissions";
import { agendaSubtreeIds, type AgendaTreeItem } from "./agendaTree";

/** How many documents the confirmation names; the rest are counted. */
export const AGENDA_DELETE_NAMED_MAX = 5;

export interface AgendaDeleteDocument {
  title: string;
  agendaItemId: string;
  /** Amendments past draft that the viewer can see. */
  amendmentCount: number;
  /** Any amendment at all; null when the viewer is not told. */
  hasAmendments: boolean | null;
}

export interface AgendaDeletePlan {
  /** Sub-items that go with the item, at any depth. */
  subItems: number;
  /** Documents that go with it: its own and its sub-items'. */
  documents: number;
  /** The titles of the first documents, to name them. */
  named: string[];
  /** Documents left unnamed. */
  unnamed: number;
  /** Titles of the documents with amendments: they keep the item. */
  blockedBy: string[];
}

/**
 * Whether a document has amendments as far as this viewer knows. Managers
 * get the exact answer (`hasAmendments`); anyone else only the amendments
 * they can see.
 */
export function documentKeepsItem(document: AgendaDeleteDocument): boolean {
  return document.hasAmendments ?? document.amendmentCount > 0;
}

/**
 * What goes when the item is deleted, from the agenda already loaded. An
 * unknown item gives an empty plan.
 */
export function planAgendaDelete<D extends AgendaDeleteDocument>(
  items: readonly AgendaTreeItem[],
  documents: readonly D[],
  itemId: string,
): AgendaDeletePlan {
  const ids = agendaSubtreeIds(items, itemId);
  const held = documents.filter((document) => ids.has(document.agendaItemId));
  return {
    subItems: Math.max(ids.size - 1, 0),
    documents: held.length,
    named: held
      .slice(0, AGENDA_DELETE_NAMED_MAX)
      .map((document) => document.title),
    unnamed: Math.max(held.length - AGENDA_DELETE_NAMED_MAX, 0),
    blockedBy: held.filter(documentKeepsItem).map((document) => document.title),
  };
}

/** Why the server refused to delete an item. */
export type AgendaDeleteRefusal =
  | { reason: "amendments"; documents: number; amendments: number }
  | { reason: "live" };

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The refusal a failed delete carries (409 with `data.code`), or null for
 * any other failure. ofetch keeps the response body in `data`, whose own
 * `data` is what createError got.
 */
export function agendaDeleteRefusal(
  error: unknown,
): AgendaDeleteRefusal | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { data?: unknown }).data;
  if (!body || typeof body !== "object") return null;
  const nested = (body as { data?: unknown }).data;
  const data = (nested && typeof nested === "object" ? nested : body) as {
    code?: unknown;
    documents?: unknown;
    amendments?: unknown;
  };
  if (data.code === AGENDA_DELETE_AMENDMENTS_CODE) {
    return {
      reason: "amendments",
      documents: count(data.documents),
      amendments: count(data.amendments),
    };
  }
  if (data.code === AGENDA_DELETE_LIVE_CODE) return { reason: "live" };
  return null;
}

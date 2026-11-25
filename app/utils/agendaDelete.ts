/**
 * What deleting an agenda item takes with it, and what keeps it from being
 * deleted. The server deletes an item with its sub-items and every document
 * under them; only amendments keep it (they are other members' work), and,
 * during the session, the item being dealt with right now.
 *
 * Every function is pure and never mutates its input.
 */

import { agendaSubtreeIds, type AgendaTreeItem } from "./agendaTree";
import {
  AGENDA_DELETE_AMENDMENTS_REASON,
  AGENDA_DELETE_LIVE_REASON,
  AGENDA_DELETE_SHEET_REASON,
} from "~~/shared/constants/errorReasons";
import { errorPayload } from "~/composables/api/useApi";

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
  | { reason: "live" }
  | { reason: "sheet" };

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The refusal a failed delete carries (409 with its `data.reason`), or null
 * for any other failure.
 */
export function agendaDeleteRefusal(
  error: unknown,
): AgendaDeleteRefusal | null {
  const { reason, data } = errorPayload(error);
  if (reason === AGENDA_DELETE_AMENDMENTS_REASON) {
    return {
      reason: "amendments",
      documents: count(data.documents),
      amendments: count(data.amendments),
    };
  }
  if (reason === AGENDA_DELETE_LIVE_REASON) return { reason: "live" };
  if (reason === AGENDA_DELETE_SHEET_REASON) return { reason: "sheet" };
  return null;
}
